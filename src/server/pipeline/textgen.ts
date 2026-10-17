import type { PoolClient } from "pg";
import { getActivePolicy, type TextgenPolicy } from "../config/policies";
import type { Db } from "../db/pool";
import { generateText, type TextDeps, type TextInput, type TextPurpose } from "../ai/llm/generate-text";
import { enqueue, type Job } from "../jobs/queue";

const PURPOSES: TextPurpose[] = ["title", "summary", "explain_priority"];

/** Encola los textos de una revisión del incidente. Idempotente por revisión; lo llaman assess_incident y plan. */
export async function enqueueTextgen(c: Db, input: { incidentId: string; revision: number; territoryId: string }): Promise<void> {
  await enqueue(c, { kind: "textgen", entityType: "incident", entityId: input.incidentId, entityRevision: input.revision, territoryId: input.territoryId });
}

type IncidentRow = {
  id: string;
  territory_id: string;
  revision: number;
  type_name: string | null;
  area_name: string | null;
  location_text: string | null;
  severity: string;
  active_hazard: boolean;
  passage: string;
  accessibility: string;
  priority_band: string;
  priority_breakdown: { rules?: string[]; promoted_by_age?: boolean; computed_band?: string; band_override?: string };
  report_count: number;
  status: string;
};

async function loadIncident(db: Db, incidentId: string): Promise<IncidentRow | null> {
  const { rows } = await db.query<IncidentRow>(
    `select i.id, i.territory_id, i.revision, pt.name as type_name, a.name as area_name, i.location_text, i.severity,
            i.active_hazard, i.passage, i.accessibility, i.priority_band, i.priority_breakdown, i.status,
            (select count(*) from report_incident_links l where l.incident_id = i.id and l.active) as report_count
     from incidents i
     left join problem_types pt on pt.id = i.problem_type_id
     left join areas a on a.id = i.area_id
     where i.id = $1`,
    [incidentId],
  );
  return rows[0] ?? null;
}

async function reportReferences(db: Db, incidentId: string, limit: number): Promise<{ id: string; text: string }[]> {
  const { rows } = await db.query<{ id: string; description: string | null }>(
    `select r.id, r.description from report_incident_links l join reports r on r.id = l.report_id
     where l.incident_id = $1 and l.active and btrim(coalesce(r.description, '')) <> ''
     order by r.confirmed_at nulls last, r.created_at limit $2`,
    [incidentId, limit],
  );
  return rows.map((r) => ({ id: r.id, text: r.description! }));
}

/** Hechos y referencias por propósito, con las etiquetas de la política. Solo lo que está en base: sin estado ni despacho. */
export function textInputs(inc: Omit<IncidentRow, "status">, reports: { id: string; text: string }[], policy: TextgenPolicy): Record<TextPurpose, TextInput> {
  const L = policy.labels;
  const label = (map: Record<string, string>, code: string) => map[code] ?? code;
  const problemType = inc.type_name ?? L.unknown_type;
  const place = [inc.location_text, inc.area_name].filter(Boolean).join(", ") || L.unknown_place;
  // Con un override del operador, los motivos calculados explican otra banda: se cita el override, no esos motivos.
  const bd = inc.priority_breakdown;
  const overridden = bd.band_override !== undefined && bd.computed_band !== undefined && bd.band_override !== bd.computed_band;
  const rules = overridden ? ["band_override"] : [...(bd.rules ?? []), ...(bd.promoted_by_age ? ["promoted_by_age"] : [])];
  const reasons = rules.map((r) => label(L.priority_rule, r));
  const base = { territoryId: inc.territory_id, entity: { type: "incident", id: inc.id, revision: inc.revision } };
  return {
    // El título sale solo de tipo y lugar (dirección y barrio, para distinguir incidentes del mismo barrio):
    // sin descripciones ciudadanas que pagar ni que filtrar.
    title: { ...base, purpose: "title", facts: { problem_type: problemType, place }, references: [] },
    summary: {
      ...base,
      purpose: "summary",
      facts: {
        problem_type: problemType,
        place,
        report_count: inc.report_count,
        severity: label(L.severity, inc.severity),
        active_hazard: label(L.active_hazard, String(inc.active_hazard)),
        passage: label(L.passage, inc.passage),
        accessibility: label(L.accessibility, inc.accessibility),
      },
      references: reports,
    },
    explain_priority: {
      ...base,
      purpose: "explain_priority",
      facts: { priority: label(L.priority_band, inc.priority_band), reason_codes: rules, reasons: reasons.length ? reasons : [["high", "medium"].includes(inc.priority_band) ? L.unexplained_band : L.no_reasons] },
      references: rules.map((r) => ({ id: r, text: label(L.priority_rule, r) })),
    },
  };
}

/**
 * Handler `textgen`: título, resumen y explicación de prioridad de una revisión del incidente.
 * Si la revisión cambió (antes o durante la redacción), descarta: la revisión nueva trae su propio job.
 * Una falla del LLM cae a plantilla; solo fallan el job los errores de base o de política.
 */
export async function runTextgen(
  deps: TextDeps,
  job: Job,
): Promise<{ discarded: boolean; sources: Partial<Record<TextPurpose, string>>; fallbacks: Partial<Record<TextPurpose, string>> }> {
  const inc = await loadIncident(deps.pool, job.entity_id);
  // Archivado (sin reportes activos): ya no se muestra al operador, no se gasta LLM en él.
  if (!inc || inc.revision !== job.entity_revision || inc.status === "archived") return { discarded: true, sources: {}, fallbacks: {} };
  const policy = (await getActivePolicy(deps.pool, inc.territory_id, "textgen")).config;
  const inputs = textInputs(inc, await reportReferences(deps.pool, inc.id, policy.max_references), policy);
  const isCurrent = async (c: PoolClient) =>
    (await c.query<{ revision: number }>("select revision from incidents where id = $1 for share", [inc.id])).rows[0]?.revision === job.entity_revision;
  // Propósitos independientes: lo que salió queda cacheado aunque otro falle; el reintento solo rehace el resto.
  const settled = await Promise.allSettled(PURPOSES.map((p) => generateText(deps, inputs[p], { isCurrent, policy })));
  const failed = settled.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  const results = settled.flatMap((r, i) => (r.status === "fulfilled" ? [[PURPOSES[i], r.value] as const] : []));
  return {
    discarded: results.some(([, r]) => r.discarded),
    sources: Object.fromEntries(results.map(([p, r]) => [p, r.source])),
    // Por qué cayó a plantilla (política apagada, sin cliente, salida inválida): para el log del worker.
    fallbacks: Object.fromEntries(results.flatMap(([p, r]) => (r.error ? [[p, r.error]] : []))),
  };
}
