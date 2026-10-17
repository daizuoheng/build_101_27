import type { Db } from "../db/pool";
import { getActivePolicy, type GroupingPolicy, type Versioned } from "../config/policies";
import { compareCandidates, type CandidateComparison, type CandidateInput, type GroupingVerdict } from "../ai/jev/compare-candidates";
import { recordAiRun } from "../ai/runs";
import { appendEvent } from "../events/append";
import { linkReport } from "../incidents/links";
import { areaName, loadEvidence, type ReportRow } from "../intake/drafts";
import type { IntakeDeps } from "../intake/orchestrator";
import { openReviewItem } from "../review/items";
import type { StorageAdapter } from "../storage/adapter";

export type Candidate = { incidentId: string; distanceM: number };
export type FoundCandidates = { candidates: Candidate[]; truncated: boolean };

/** Incidentes abiertos del territorio dentro del radio, por distancia. Pide uno de más para saber si el límite truncó. */
export async function findCandidates(
  db: Db,
  { territoryId, lon, lat, radiusM, limit }: { territoryId: string; lon: number; lat: number; radiusM: number; limit: number },
): Promise<FoundCandidates> {
  const { rows } = await db.query<{ id: string; distance_m: number }>(
    `with p as (select st_setsrid(st_makepoint($2, $3), 4326)::geography as g)
     select i.id, st_distance(i.location, p.g) as distance_m
     from incidents i, p
     where i.territory_id = $1 and i.status in ('open', 'assigned', 'in_progress') and st_dwithin(i.location, p.g, $4)
     order by distance_m, i.id
     limit $5`,
    [territoryId, lon, lat, radiusM, limit + 1],
  );
  return { candidates: rows.slice(0, limit).map((r) => ({ incidentId: r.id, distanceM: r.distance_m })), truncated: rows.length > limit };
}

/** Evidencia original de cada candidato: reportes activos (los primeros por confirmación), sus textos y fotos derivadas. */
async function loadCandidateInputs(db: Db, storage: StorageAdapter, found: Candidate[], policy: GroupingPolicy): Promise<CandidateInput[]> {
  return Promise.all(
    found.map(async (c) => {
      const inc = await db.query<{ status: string; category: string | null; created_at: Date; report_count: number }>(
        `select i.status, pt.name as category, i.created_at,
           (select count(*) from report_incident_links l where l.incident_id = i.id and l.active)::int as report_count
         from incidents i left join problem_types pt on pt.id = i.problem_type_id where i.id = $1`,
        [c.incidentId],
      );
      const reps = await db.query<{ id: string; confirmed_at: Date }>(
        `select r.id, r.confirmed_at from report_incident_links l join reports r on r.id = l.report_id
         where l.incident_id = $1 and l.active order by r.confirmed_at, r.id limit $2`,
        [c.incidentId, policy.evidence.max_reports_per_candidate],
      );
      const reports = await Promise.all(
        reps.rows.map(async (r) => ({ reportId: r.id, confirmedAt: r.confirmed_at.toISOString(), ...(await loadEvidence(db, storage, r.id)) })),
      );
      const i = inc.rows[0];
      return {
        incidentId: c.incidentId,
        distanceM: c.distanceM,
        summary: { category: i.category, status: i.status, firstReportedAt: i.created_at.toISOString(), reportCount: i.report_count },
        evidence: { reports },
      };
    }),
  );
}

export type GroupingPlan = {
  policy: Versioned<GroupingPolicy>;
  found: FoundCandidates;
  comparison: { aiRunId: string; perCandidate: CandidateComparison[]; verdict: GroupingVerdict } | null;
};

/**
 * Busca candidatos y, si hay, los compara con Jev. Corre FUERA de la transacción: la llamada de red no retiene locks.
 * Un fallo del proveedor se propaga para que el worker reintente (y al agotar, `provider_failure`).
 */
export async function prepareGrouping(deps: IntakeDeps, r: ReportRow & { territory_id: string; lon: number; lat: number }): Promise<GroupingPlan> {
  const policy = await getActivePolicy(deps.pool, r.territory_id, "grouping");
  const found = await findCandidates(deps.pool, {
    territoryId: r.territory_id, lon: r.lon, lat: r.lat, radiusM: policy.config.radius_m, limit: policy.config.max_candidates,
  });
  if (found.candidates.length === 0) return { policy, found, comparison: null };

  const own = await loadEvidence(deps.pool, deps.storage, r.id);
  const confirmedAt = (await deps.pool.query<{ confirmed_at: Date }>("select confirmed_at from reports where id = $1", [r.id])).rows[0].confirmed_at;
  const res = await compareCandidates(
    {
      reportId: r.id,
      reportRevision: r.confirmed_revision!,
      report: { confirmedAt: confirmedAt.toISOString(), ...own, location: { text: r.location_text, areaName: await areaName(deps.pool, r.area_id) } },
      candidates: await loadCandidateInputs(deps.pool, deps.storage, found.candidates, policy.config),
      truncated: found.truncated,
      policy,
    },
    { jev: deps.jev, recordRun: (run) => recordAiRun(deps.pool, run) },
  );
  if (!res.ok) throw new Error(`comparación fallida (${res.error.kind}): ${res.error.message}`);
  return { policy, found, comparison: { aiRunId: res.aiRunId, perCandidate: res.value.perCandidate, verdict: res.value.verdict } };
}

/** ¿Siguen siendo los mismos candidatos? Se revalida bajo el lock del territorio antes de escribir. */
export function sameCandidates(a: FoundCandidates, b: FoundCandidates): boolean {
  return a.truncated === b.truncated && a.candidates.length === b.candidates.length && a.candidates.every((c, i) => c.incidentId === b.candidates[i].incidentId);
}

const OUTCOME = { link: "same", create: "different", review: "uncertain" } as const;

/** Persiste la decisión (siempre, con origen auto) y, si es `link`, asocia. Devuelve qué hacer después. Dentro de la transacción. */
export async function applyGrouping(
  c: Db,
  { report, plan, verdict, evidenceRefs }: { report: { id: string; territoryId: string }; plan: GroupingPlan; verdict: GroupingVerdict; evidenceRefs: Record<string, unknown> },
): Promise<{ decisionId: string; kind: GroupingVerdict["kind"]; incidentId: string | null }> {
  const outcome = verdict.kind === "create" && !plan.comparison ? "no_candidates" : OUTCOME[verdict.kind];
  // Sin comparación (sin candidatos, o candidatos que cambiaron antes de escribir) se guardan los candidatos vigentes sin respuesta de Jev.
  const candidates = plan.comparison
    ? plan.comparison.perCandidate.map((p) => ({
        ref: p.ref, incident_id: p.incidentId, distance_m: Math.round(p.distanceM),
        match: { choice: p.match.choice, probabilities: p.match.probabilities, confidence: p.match.confidence }, conflicts: p.conflicts,
      }))
    : plan.found.candidates.map((x) => ({ incident_id: x.incidentId, distance_m: Math.round(x.distanceM), match: null }));
  const dec = await c.query<{ id: string }>(
    `insert into grouping_decisions (report_id, ai_run_id, candidates, outcome, chosen_incident_id, policy_version_id, origin)
     values ($1, $2, $3, $4, $5, $6, 'auto') returning id`,
    [report.id, plan.comparison?.aiRunId ?? null, JSON.stringify(candidates), outcome, verdict.kind === "link" ? verdict.incidentId : null, plan.policy.id],
  );
  const decisionId = dec.rows[0].id;
  await appendEvent(c, {
    entityType: "report", entityId: report.id, kind: "grouping_decided", actorType: "system",
    data: { decision_id: decisionId, outcome, verdict: verdict.kind, reasons: verdict.reasons, truncated: plan.found.truncated },
  });

  if (verdict.kind === "link") {
    await linkReport(c, { reportId: report.id, incidentId: verdict.incidentId, origin: "auto", groupingDecisionId: decisionId, actor: { type: "system", id: null } });
    return { decisionId, kind: "link", incidentId: verdict.incidentId };
  }
  if (verdict.kind === "review") {
    const candidateIds = plan.found.candidates.map((x) => x.incidentId);
    await c.query("update reports set grouping = 'review', updated_at = now() where id = $1", [report.id]);
    await openReviewItem(c, {
      territoryId: report.territoryId, kind: "uncertain_duplicate", entityType: "report", entityId: report.id,
      reasons: verdict.reasons.map((code) => ({ code })),
      evidenceRefs: [{ ...evidenceRefs, grouping_decision_id: decisionId, ai_run_id: plan.comparison?.aiRunId ?? null, candidate_incident_ids: candidateIds }],
    });
    // Mientras no se decida, ningún candidato se despacha solo.
    await c.query("update incidents set dispatch_blocked = true, updated_at = now() where id = any($1)", [candidateIds]);
    return { decisionId, kind: "review", incidentId: null };
  }
  return { decisionId, kind: "create", incidentId: null };
}
