import { withTx } from "../db/tx";
import type { Db } from "../db/pool";
import { getActiveCatalog } from "../config/catalog";
import { getActivePolicy } from "../config/policies";
import { assessIncident, type IncidentAssessmentResult } from "../ai/jev/assess-incident";
import { chosenProbability } from "../ai/jev/thresholds";
import { recordAiRun } from "../ai/runs";
import { appendEvent } from "../events/append";
import { latestAssessed, recomputeEffective } from "../incidents/effective";
import { mergeAssessment } from "../incidents/overrides";
import { loadEvidence } from "../intake/drafts";
import type { IntakeDeps } from "../intake/orchestrator";
import type { Job } from "../jobs/queue";
import { openReviewItem } from "../review/items";

const OPEN_STATUSES = ["open", "assigned", "in_progress"];

type IncidentRow = {
  id: string; territory_id: string; revision: number; status: string; created_at: Date; problem_type_name: string | null;
  severity: string; active_hazard: boolean; passage: string; accessibility: string;
};

async function loadIncident(db: Db, id: string, lock = false): Promise<IncidentRow | null> {
  const { rows } = await db.query<IncidentRow>(
    `select i.id, i.territory_id, i.revision, i.status, i.created_at, pt.name as problem_type_name,
       i.severity, i.active_hazard, i.passage, i.accessibility
     from incidents i left join problem_types pt on pt.id = i.problem_type_id
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
 * `assess_incident`: reevaluación con la evidencia acumulada (se encola cuando cambian los reportes del incidente).
 * Jev fuera de la transacción; bajo el lock del territorio se descarta si el incidente cambió de revisión.
 * La IA parte de su evaluación anterior (nunca de valores corregidos por humanos); las correcciones se aplican después.
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
  const reportsConsidered = chosen.map((r) => r.id).sort(); // solo lo que Jev efectivamente ve

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
        problemType: inc0.problem_type_name, severity: inc0.severity, activeHazard: inc0.active_hazard,
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
  const ai = res.value;

  await withTx(async (c) => {
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [territoryId]);
    const inc = await loadIncident(c, inc0.id, true);
    if (!inc || !OPEN_STATUSES.includes(inc.status) || inc.revision !== job.entity_revision) return; // cambió mientras Jev evaluaba
    const already = await c.query("select 1 from incident_assessments where incident_id = $1 and incident_revision = $2", [inc.id, inc.revision]);
    if (already.rows[0]) return; // reintento de una revisión ya evaluada

    const assessed = mergeAssessment(await latestAssessed(c, inc.id), ai, policy.config.assessment);
    const freshCounts = await sourceCounts(c, inc.id, planning.config.window_hours);
    const r = await recomputeEffective(c, inc.id, assessed, { reason: "assessment" });
    await c.query(
      `insert into incident_assessments (incident_id, incident_revision, ai_run_id, reports_considered, problem_type_id, severity, active_hazard,
         evidence_summary, changes, source_counts)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        inc.id, inc.revision, res.aiRunId, reportsConsidered, assessed.problemTypeId, assessed.severity, assessed.activeHazard,
        JSON.stringify({ ai: aiSnapshot(ai), assessed, all_report_ids: all.map((x) => x.id).sort(), policy_version_id: policy.id, catalog_hash: catalog.hash }),
        JSON.stringify(r.changes), JSON.stringify(freshCounts),
      ],
    );
    if (ai.consistency.choice === "contradiction" && chosenProbability(ai.consistency) >= policy.config.assessment.min_contradiction) {
      await openReviewItem(c, {
        territoryId, kind: "contradiction", entityType: "incident", entityId: inc.id,
        reasons: [{ code: "reports_contradict", ai_run_id: res.aiRunId }], evidenceRefs: reportsConsidered.map((report_id) => ({ report_id })),
      });
    }
    await appendEvent(c, {
      entityType: "incident", entityId: inc.id, kind: "assessed", actorType: "system",
      data: { revision: inc.revision, ai_run_id: res.aiRunId, band: r.band, changes: r.changes },
    });
  }, pool);
}

/**
 * Al agotar reintentos: el incidente queda con sus valores vigentes y en revisión (sin despacho automático).
 * Si el job ya era obsoleto (el incidente cambió o se cerró), no se abre nada: otro job lo reevalúa.
 */
export async function onAssessIncidentFailed(deps: IntakeDeps, job: Job, error: string): Promise<void> {
  const inc = await loadIncident(deps.pool, job.entity_id);
  if (!inc || !OPEN_STATUSES.includes(inc.status) || inc.revision !== job.entity_revision) return;
  await openReviewItem(deps.pool, {
    territoryId: job.territory_id, kind: "provider_failure", entityType: "incident", entityId: job.entity_id,
    reasons: [{ code: "provider_failure", stage: "assess_incident", revision: job.entity_revision, error: error.slice(0, 500) }],
  });
}
