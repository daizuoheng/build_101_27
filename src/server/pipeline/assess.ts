import { withTx } from "../db/tx";
import type { Db } from "../db/pool";
import { getActiveCatalog } from "../config/catalog";
import { getActivePolicy } from "../config/policies";
import { assessIncident, type IncidentAssessmentResult } from "../ai/jev/assess-incident";
import { chosenProbability } from "../ai/jev/thresholds";
import { recordAiRun } from "../ai/runs";
import { appendEvent } from "../events/append";
import { applyOverrides, liveOverrides, markIncompatibleAssignment, mergeAssessment, type Assessed } from "../incidents/overrides";
import { loadEvidence } from "../intake/drafts";
import type { IntakeDeps } from "../intake/orchestrator";
import { enqueue, type Job } from "../jobs/queue";
import { openReviewItem } from "../review/items";
import { computePriority } from "./priority";

const OPEN_STATUSES = ["open", "assigned", "in_progress"];

type IncidentRow = Assessed & {
  id: string; territory_id: string; revision: number; status: string; created_at: Date; area_name: string | null;
  priority_band: string; problem_type_name: string | null;
};

async function loadIncident(db: Db, id: string, lock = false): Promise<IncidentRow | null> {
  const { rows } = await db.query<IncidentRow>(
    `select i.id, i.territory_id, i.revision, i.status, i.created_at, i.priority_band, a.name as area_name, pt.name as problem_type_name,
       i.problem_type_id as "problemTypeId", i.severity, i.active_hazard as "activeHazard", i.passage, i.accessibility
     from incidents i left join areas a on a.id = i.area_id left join problem_types pt on pt.id = i.problem_type_id
     where i.id = $1 ${lock ? "for update of i" : ""}`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Conteos del backend (Jev no cuenta): mensajes, fuentes distintas estimadas (sesiones), fuentes dentro de la ventana
 * del planificador y evidencia repetida (adjuntos idénticos por sha256). Reintentos y textos generados no suman.
 */
export async function sourceCounts(db: Db, incidentId: string, windowHours: number) {
  const { rows } = await db.query<{ reports: number; messages: number; sources: number; sources_in_window: number; repeated_evidence: number }>(
    `with r as (
       select rep.id, rep.citizen_session_id, rep.confirmed_at from report_incident_links l join reports rep on rep.id = l.report_id
       where l.incident_id = $1 and l.active)
     select (select count(*) from r)::int as reports,
       (select count(*) from messages m join conversations c on c.id = m.conversation_id
          where c.report_id in (select id from r) and m.role = 'citizen')::int as messages,
       (select count(distinct citizen_session_id) from r)::int as sources,
       (select count(distinct citizen_session_id) from r where confirmed_at >= now() - make_interval(hours => $2))::int as sources_in_window,
       (select coalesce(sum(n - 1), 0) from (select count(*) as n from attachments
          where report_id in (select id from r) and purpose = 'original' group by sha256) d)::int as repeated_evidence`,
    [incidentId, windowHours],
  );
  return { ...rows[0], window_hours: windowHours };
}

/** Reportes a mandar a Jev: el primero (para comparar evolución) y los más recientes, hasta el máximo de la política. */
async function pickReports(db: Db, incidentId: string, max: number) {
  const { rows } = await db.query<{ id: string; confirmed_at: Date }>(
    `select r.id, r.confirmed_at from report_incident_links l join reports r on r.id = l.report_id
     where l.incident_id = $1 and l.active order by r.confirmed_at, r.id`,
    [incidentId],
  );
  if (rows.length <= max) return { all: rows, chosen: rows };
  return { all: rows, chosen: [rows[0], ...rows.slice(rows.length - (max - 1))] };
}

const aiSnapshot = (ai: IncidentAssessmentResult) => {
  const c = (a: { choice: string; probabilities: Record<string, number> }) => ({ choice: a.choice, p: Math.round(chosenProbability(a as never) * 1000) / 1000 });
  return {
    model: ai.model, problem_type: c(ai.problemType), problem_type_id: ai.problemTypeId, severity: c(ai.severity), active_fire: c(ai.activeFire),
    passage: c(ai.passage), accessibility: c(ai.accessibility), evolution: c(ai.evolution), consistency: c(ai.consistency),
  };
};

/**
 * `assess_incident`: reevaluación con la evidencia acumulada. Jev fuera de la transacción; bajo el lock del territorio
 * se descarta si el incidente cambió de revisión. Conserva overrides, recalcula prioridad, sube la revisión si cambió
 * algo efectivo y encola `plan`. Si solo cambió una corrección (mismos reportes), reutiliza la respuesta anterior de Jev.
 */
export async function runAssessIncident(deps: IntakeDeps, job: Job): Promise<void> {
  const pool = deps.pool;
  const inc0 = await loadIncident(pool, job.entity_id);
  if (!inc0 || !OPEN_STATUSES.includes(inc0.status) || inc0.revision !== job.entity_revision) return; // cerrado u obsoleto
  const territoryId = inc0.territory_id;
  const policy = await getActivePolicy(pool, territoryId, "evaluation");
  const planning = await getActivePolicy(pool, territoryId, "planning");
  const { all, chosen } = await pickReports(pool, inc0.id, policy.config.assessment.max_reports);
  if (!all.length) return; // sin reportes: lo archiva el flujo de desasociación
  const considered = all.map((r) => r.id).sort();

  // ¿Misma evidencia que la última evaluación con Jev? (p. ej. el cambio fue una corrección del operador)
  const prev = await pool.query<{ ai_run_id: string; reports_considered: string[]; evidence_summary: { ai?: unknown; ai_result?: IncidentAssessmentResult } }>(
    "select ai_run_id, reports_considered, evidence_summary from incident_assessments where incident_id = $1 and ai_run_id is not null order by incident_revision desc limit 1",
    [inc0.id],
  );
  const reusable = prev.rows[0] && prev.rows[0].evidence_summary.ai_result
    && [...prev.rows[0].reports_considered].sort().join() === considered.join();

  let ai: IncidentAssessmentResult;
  let aiRunId: string;
  if (reusable) {
    ai = prev.rows[0].evidence_summary.ai_result!;
    aiRunId = prev.rows[0].ai_run_id;
  } else {
    const counts = await sourceCounts(pool, inc0.id, planning.config.window_hours);
    const catalog = await getActiveCatalog(pool, territoryId);
    const reports = await Promise.all(
      chosen.map(async (r) => {
        const ev = await loadEvidence(pool, deps.storage, r.id);
        return { reportId: r.id, confirmedAt: r.confirmed_at.toISOString(), messages: ev.messages, images: ev.images };
      }),
    );
    const res = await assessIncident(
      {
        incidentId: inc0.id,
        incidentRevision: inc0.revision,
        current: {
          problemType: inc0.problem_type_name, severity: inc0.severity, activeHazard: inc0.activeHazard,
          passage: inc0.passage, accessibility: inc0.accessibility, firstReportedAt: inc0.created_at.toISOString(),
        },
        counts: { reports: counts.reports, messages: counts.messages, sources: counts.sources, repeatedEvidence: counts.repeated_evidence },
        reports,
        catalog: catalog.types,
        policy,
      },
      { jev: deps.jev, recordRun: (run) => recordAiRun(pool, run) },
    );
    if (!res.ok) throw new Error(`reevaluación fallida (${res.error.kind}): ${res.error.message}`);
    ai = res.value;
    aiRunId = res.aiRunId;
  }

  await withTx(async (c) => {
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [territoryId]);
    const inc = await loadIncident(c, inc0.id, true);
    if (!inc || !OPEN_STATUSES.includes(inc.status) || inc.revision !== job.entity_revision) return; // cambió mientras Jev evaluaba
    const counts = await sourceCounts(c, inc.id, planning.config.window_hours);
    const previous: Assessed = { problemTypeId: inc.problemTypeId, severity: inc.severity, activeHazard: inc.activeHazard, passage: inc.passage, accessibility: inc.accessibility };
    const assessed = mergeAssessment(previous, ai, policy.config.assessment);
    const { effective, bandOverride, discrepancies } = applyOverrides(assessed, await liveOverrides(c, inc.id));

    const priorityPolicy = await getActivePolicy(c, territoryId, "priority");
    const computed = computePriority(effective, inc.created_at, new Date(), priorityPolicy.config);
    const band = bandOverride ?? computed.band;
    const breakdown = { ...computed.breakdown, computed_band: computed.band, ...(bandOverride ? { band_override: bandOverride } : {}) };

    const fields = ["problemTypeId", "severity", "activeHazard", "passage", "accessibility"] as const;
    const changes: Record<string, unknown>[] = fields
      .filter((f) => previous[f] !== effective[f])
      .map((f) => ({ field: f, from: previous[f], to: effective[f], source: discrepancies.some((d) => d.field === toColumn(f)) ? "override" : "ai" }));
    if (inc.priority_band !== band) changes.push({ field: "priority_band", from: inc.priority_band, to: band, source: bandOverride ? "override" : "rules" });
    changes.push(...discrepancies);

    const ins = await c.query(
      `insert into incident_assessments (incident_id, incident_revision, ai_run_id, reports_considered, problem_type_id, severity, active_hazard,
         evidence_summary, changes, source_counts)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (incident_id, incident_revision) do nothing`,
      [
        inc.id, inc.revision, aiRunId, considered, effective.problemTypeId, effective.severity, effective.activeHazard,
        JSON.stringify({ ai: aiSnapshot(ai), ai_result: ai, assessed, effective, reused_ai_run: reusable ?? false }),
        JSON.stringify(changes), JSON.stringify(counts),
      ],
    );
    if (!ins.rowCount) return; // ya evaluada esta revisión (reintento)

    const materialChange = changes.some((ch) => !("override" in ch));
    if (materialChange) {
      const typeName = effective.problemTypeId
        ? (await c.query<{ name: string }>("select name from problem_types where id = $1", [effective.problemTypeId])).rows[0]?.name
        : null;
      await c.query(
        `update incidents set problem_type_id = $2, severity = $3, active_hazard = $4, passage = $5, accessibility = $6,
           priority_band = $7, priority_breakdown = $8, title = $9, revision = revision + 1, updated_at = now() where id = $1`,
        [inc.id, effective.problemTypeId, effective.severity, effective.activeHazard, effective.passage, effective.accessibility,
          band, breakdown, [typeName ?? "Problema sin clasificar", inc.area_name ? `— ${inc.area_name}` : null].filter(Boolean).join(" ")],
      );
    } else {
      await c.query("update incidents set priority_breakdown = $2, updated_at = now() where id = $1", [inc.id, breakdown]);
    }

    // Un cambio de tipo o un peligro activo nuevo cambia la capacidad requerida: una orden activa ya no corresponde.
    const typeChanged = previous.problemTypeId !== effective.problemTypeId;
    const hazardOn = !previous.activeHazard && effective.activeHazard;
    if (typeChanged || hazardOn) {
      await markIncompatibleAssignment(c, { id: inc.id, territoryId }, [{ code: typeChanged ? "type_changed" : "active_hazard_detected", source: "assessment" }]);
    }
    if (ai.consistency.choice === "contradiction" && chosenProbability(ai.consistency) >= policy.config.assessment.min_contradiction) {
      await openReviewItem(c, {
        territoryId, kind: "contradiction", entityType: "incident", entityId: inc.id,
        reasons: [{ code: "reports_contradict", ai_run_id: aiRunId }], evidenceRefs: considered.map((report_id) => ({ report_id })),
      });
    }
    await appendEvent(c, {
      entityType: "incident", entityId: inc.id, kind: "assessed", actorType: "system",
      data: { revision: inc.revision, ai_run_id: aiRunId, reused: reusable ?? false, band, changes },
    });
    await enqueue(c, { kind: "plan", entityType: "territory", entityId: territoryId, entityRevision: 0, territoryId, dedupeSuffix: `assess:${inc.id}:${inc.revision}` });
  }, pool);
}

const toColumn = (f: string) => (f === "problemTypeId" ? "problem_type_id" : f);

/** Al agotar reintentos: el incidente queda con sus valores vigentes y en revisión (sin despacho automático). */
export async function onAssessIncidentFailed(deps: IntakeDeps, job: Job, error: string): Promise<void> {
  await openReviewItem(deps.pool, {
    territoryId: job.territory_id, kind: "provider_failure", entityType: "incident", entityId: job.entity_id,
    reasons: [{ code: "provider_failure", stage: "assess_incident", revision: job.entity_revision, error: error.slice(0, 500) }],
  });
}
