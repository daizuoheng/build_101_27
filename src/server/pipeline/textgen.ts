import type { Pool, PoolClient } from "pg";
import { getActivePolicy, type TextgenPolicy } from "../config/policies";
import type { Db } from "../db/pool";
import { withTx } from "../db/tx";
import { generateText, type GeneratedText, type TextDeps, type TextInput, type TextPurpose } from "../ai/llm/generate-text";
import { enqueue, type Job } from "../jobs/queue";

const PURPOSES: TextPurpose[] = ["title", "summary", "explain_priority"];

/**
 * Encola los textos de una revisión del incidente. Idempotente por revisión. Lo llaman la creación del incidente,
 * `runAssessIncident` y `recomputeEffective`; `plan` solo renueva `explain_priority` (ver `planInTx`), con
 * `dedupeSuffix` porque la banda por antigüedad cambia sin revisión nueva.
 */
export async function enqueueTextgen(c: Db, input: { incidentId: string; revision: number; territoryId: string; dedupeSuffix?: string }): Promise<void> {
  await enqueue(c, {
    kind: "textgen", entityType: "incident", entityId: input.incidentId, entityRevision: input.revision, territoryId: input.territoryId,
    ...(input.dedupeSuffix !== undefined ? { dedupeSuffix: input.dedupeSuffix } : {}),
  });
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
 * Copia título y resumen a `incidents.title` / `incidents.summary`, que leen la consola del operador y la bandeja de la
 * unidad. Solo si la revisión sigue siendo la redactada y el incidente no se archivó: si subió mientras tanto, el job
 * de la revisión nueva escribe los suyos. Bloquea la fila para que una revisión nueva no se cuele entre el chequeo y
 * la escritura.
 */
async function applyTexts(pool: Pool, incidentId: string, revision: number, texts: { title: string; summary: string }): Promise<boolean> {
  return withTx(async (c) => {
    const cur = (await c.query<{ revision: number; status: string }>("select revision, status from incidents where id = $1 for update", [incidentId])).rows[0];
    if (!cur || cur.revision !== revision || cur.status === "archived") return false;
    await c.query("update incidents set title = $2, summary = $3, updated_at = now() where id = $1", [incidentId, texts.title, texts.summary]);
    return true;
  }, pool);
}

/**
 * Handler `textgen`: título, resumen y explicación de prioridad de una revisión del incidente.
 * Si la revisión cambió (antes o durante la redacción), descarta: la revisión nueva trae su propio job.
 * Una falla del LLM cae a plantilla; solo fallan el job los errores de base o de política.
 * Sin descarte, deja título y resumen en las columnas del incidente (`applied`).
 */
export async function runTextgen(
  deps: TextDeps,
  job: Job,
): Promise<{ discarded: boolean; applied: boolean; sources: Partial<Record<TextPurpose, string>>; fallbacks: Partial<Record<TextPurpose, string>> }> {
  const inc = await loadIncident(deps.pool, job.entity_id);
  // Archivado (sin reportes activos): ya no se muestra al operador, no se gasta LLM en él.
  if (!inc || inc.revision !== job.entity_revision || inc.status === "archived") return { discarded: true, applied: false, sources: {}, fallbacks: {} };
  const policy = (await getActivePolicy(deps.pool, inc.territory_id, "textgen")).config;
  const inputs = textInputs(inc, await reportReferences(deps.pool, inc.id, policy.max_references), policy);
  // La explicación depende además de la banda, que `plan` puede promover por antigüedad sin subir la revisión: si
  // cambió mientras se redactaba, se descarta (el job `band:<banda>` que encoló `plan` la vuelve a redactar).
  const isCurrent = (purpose: TextPurpose) => async (c: PoolClient) => {
    const cur = (await c.query<{ revision: number; priority_band: string }>("select revision, priority_band from incidents where id = $1 for share", [inc.id])).rows[0];
    return cur?.revision === job.entity_revision && (purpose !== "explain_priority" || cur.priority_band === inc.priority_band);
  };
  // Propósitos independientes: lo que salió queda cacheado aunque otro falle; el reintento solo rehace el resto.
  const settled = await Promise.allSettled(PURPOSES.map((p) => generateText(deps, inputs[p], { isCurrent: isCurrent(p), policy })));
  const failed = settled.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  const results = settled.flatMap((r, i) => (r.status === "fulfilled" ? [[PURPOSES[i], r.value] as const] : []));
  const discarded = results.some(([, r]) => r.discarded);
  const byPurpose = Object.fromEntries(results) as Record<TextPurpose, GeneratedText>;
  const applied = !discarded && (await applyTexts(deps.pool, inc.id, job.entity_revision, { title: byPurpose.title.body, summary: byPurpose.summary.body }));
  return {
    discarded,
    applied,
    sources: Object.fromEntries(results.map(([p, r]) => [p, r.source])),
    // Por qué cayó a plantilla (textgen apagado, sin cliente, salida inválida) para el log del worker. Un propósito
    // determinista por llm_purposes no es un fallo y no aparece acá.
    fallbacks: Object.fromEntries(results.flatMap(([p, r]) => (r.error ? [[p, r.error]] : []))),
  };
}
