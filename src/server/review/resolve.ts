// Resolución de ítems de revisión (Tarea 14). Cada acción se aplica con el servicio de dominio de su módulo; acá solo
// se valida, se cierra el ítem, se recalcula el bloqueo de despacho y se replanifica. Todo en la transacción del llamador.

import type { Db } from "../db/pool";
import type { Actor, ResolveReviewItem } from "../contracts";
import { appendEvent } from "../events/append";
import { badRequest, conflict, notFound } from "../errors";
import { locatePoint } from "../geo/locate";
import { isUuid } from "../ids";
import { setOverride } from "../incidents/overrides";
import { linkReport } from "../incidents/links";
import { getReport } from "../intake/drafts";
import { getEvaluation } from "../intake/evaluations";
import { enqueue } from "../jobs/queue";
import { createIncidentFromReport } from "../pipeline/create-incident";
import { actionsFor, type ReviewEntityType } from "./actions";
import { incidentsAffectedByReviewItem, openReviewItem, recomputeDispatchBlocked } from "./items";
import type { ResolveAction, ResolveBody, ReviewKind } from "@/shared/contracts/review";

type Item = {
  id: string;
  territory_id: string | null;
  kind: ReviewKind;
  entity_type: ReviewEntityType;
  entity_id: string;
  status: string;
  evidence_refs: Record<string, unknown>[];
};

type Status = "resolved" | "dismissed";

const notFoundItem = () => notFound("Ítem de revisión inexistente.");

/** Territorio del ítem, para autorizar al operador antes de actuar. Id que no es uuid o inexistente ⇒ 404. */
export async function reviewItemTerritory(db: Db, reviewItemId: string): Promise<string | null> {
  if (!isUuid(reviewItemId)) throw notFoundItem();
  const { rows } = await db.query<{ territory_id: string | null }>("select territory_id from review_items where id = $1", [reviewItemId]);
  if (!rows[0]) throw notFoundItem();
  return rows[0].territory_id;
}

const operatorId = (actor: Actor) => {
  if (actor.type !== "operator" || !actor.id) throw badRequest("operator_required", "La revisión la resuelve un operador identificado.");
  return actor.id;
};

/** Incidentes candidatos de un `uncertain_duplicate` (todas sus evidencias, como los bloquea `recomputeDispatchBlocked`). */
const candidatesOf = (item: Item): string[] =>
  item.evidence_refs.flatMap((ref) => (Array.isArray(ref.candidate_incident_ids) ? ref.candidate_incident_ids.map(String) : []));

async function createIncident(c: Db, item: Item, actor: Actor): Promise<Record<string, unknown>> {
  const r = await getReport(c, item.entity_id, { forUpdate: true });
  const ev = r.status === "confirmed" && r.confirmed_revision !== null ? await getEvaluation(c, r.id, r.confirmed_revision) : null;
  // `insufficient` sí se puede promover: es justamente la decisión que se le pide al operador. Ajeno no.
  if (!ev || ev.intent === "other" || ev.applicability === "unrelated") {
    throw badRequest("report_not_promotable", "El reporte no tiene una evaluación que permita crear un incidente.");
  }
  const located = r.lon !== null && r.lat !== null ? await locatePoint(c, r.lon, r.lat) : null;
  if (!located || located.territoryId !== r.territory_id) {
    throw badRequest("report_not_promotable", "El reporte queda fuera de la cobertura del territorio.");
  }
  await requireUnlinked(c, r.id);

  // `createIncidentFromReport` ya deja el reporte con `grouping = 'linked'` (vía `insertLink`).
  const { incidentId, priorityBand } = await createIncidentFromReport(c, {
    reportId: r.id, evaluation: ev, areaId: located.areaId, areaName: located.areaName, groupingDecisionId: null, origin: "manual",
  });
  await appendEvent(c, {
    entityType: "incident", entityId: incidentId, kind: "incident_created_manually", actorType: "operator", actorId: actor.id,
    data: { report_id: r.id, evaluation_id: ev.id, priority: priorityBand, review_item_id: item.id },
  });
  await moveEvaluationReviews(c, item, incidentId, actor);
  return { incident_id: incidentId };
}

/**
 * La cola decide la agrupación de un reporte: si ya quedó asociado por otro camino (detalle del incidente, otro
 * operador), no se lo mueve desde acá; `linkReport` lo movería y podría archivar el incidente anterior.
 */
async function requireUnlinked(c: Db, reportId: string) {
  const linked = await c.query("select 1 from report_incident_links where report_id = $1 and active", [reportId]);
  if (linked.rows[0]) throw conflict("report_already_linked", "El reporte ya está asociado a un incidente.");
}

/** Dudas de la evaluación del reporte: mientras se decidía la agrupación quedaron sobre el reporte. */
const EVALUATION_KINDS: ReviewKind[] = ["insufficient_evidence", "contradiction", "low_confidence", "unknown_type"];

/**
 * Al decidir la agrupación, las dudas de evaluación abiertas sobre el reporte pasan al incidente, como en el camino
 * automático (`openEvaluationReviews("incident")` de process-report): ahí bloquean el despacho hasta revisarlas.
 */
async function moveEvaluationReviews(c: Db, item: Item, incidentId: string, actor: Actor) {
  const { rows } = await c.query<{ id: string; kind: ReviewKind; reasons: unknown[]; evidence_refs: unknown[] }>(
    `select id, kind, reasons, evidence_refs from review_items
     where entity_type = 'report' and entity_id = $1 and status = 'open' and id <> $2 and kind = any($3) for update`,
    [item.entity_id, item.id, EVALUATION_KINDS],
  );
  for (const r of rows) {
    await openReviewItem(c, { territoryId: item.territory_id, kind: r.kind, entityType: "incident", entityId: incidentId, reasons: r.reasons, evidenceRefs: r.evidence_refs });
    await c.query(
      `update review_items set status = 'dismissed', resolution = jsonb_build_object('action', 'dismiss', 'reason', 'moved_to_incident', 'incident_id', $2::text),
         resolved_by = $3, resolved_at = now(), updated_at = now() where id = $1`,
      [r.id, incidentId, actor.id],
    );
  }
}

/** Corrección de tipo o severidad con la revisión vigente, leída bajo el lock: la cola no trae una revisión vieja. */
async function correct(c: Db, item: Item, actor: Actor, resolution: Extract<ResolveAction, { action: "set_type" | "set_severity" }>, note?: string) {
  const inc = await c.query<{ revision: number }>("select revision from incidents where id = $1 for update", [item.entity_id]);
  if (!inc.rows[0]) throw notFound("Incidente inexistente.");
  const override = resolution.action === "set_type"
    ? { field: "problem_type_id" as const, value: resolution.problemTypeId }
    : { field: "severity" as const, value: resolution.severity };
  const res = await setOverride(c, {
    incidentId: item.entity_id, override, reason: note ?? `revisión: ${item.kind}`, actor, expectedRevision: inc.rows[0].revision,
  });
  return { revision: res.revision };
}

/** Evidencia aceptada. Sobre un incidente el desbloqueo sale del recálculo; sobre una orden, además se libera la orden. */
async function allowDispatch(c: Db, item: Item, actor: Actor): Promise<Record<string, unknown>> {
  if (item.entity_type !== "assignment") return {};
  // Mismo orden de bloqueo que el despacho y las transiciones: incidente → orden.
  const ref = await c.query<{ incident_id: string }>("select incident_id from assignments where id = $1", [item.entity_id]);
  if (!ref.rows[0]) throw notFound("Orden inexistente.");
  await c.query("select 1 from incidents where id = $1 for update", [ref.rows[0].incident_id]);
  const { rows } = await c.query<{ version: number }>(
    "update assignments set review_blocked = false, version = version + 1, updated_at = now() where id = $1 and review_blocked returning version",
    [item.entity_id],
  );
  if (rows[0]) {
    await appendEvent(c, {
      entityType: "assignment", entityId: item.entity_id, kind: "review_unblocked", actorType: "operator", actorId: actor.id,
      data: { review_item_id: item.id, version: rows[0].version },
    });
  }
  return { assignment_version: rows[0]?.version ?? null };
}

/** Reintento de la etapa que falló: `enqueue` revive el job fallido con los intentos en cero. */
async function retry(c: Db, item: Item, actor: Actor): Promise<Record<string, unknown>> {
  if (item.entity_type === "incident") {
    const inc = await c.query<{ revision: number; territory_id: string }>("select revision, territory_id from incidents where id = $1", [item.entity_id]);
    if (!inc.rows[0]) throw notFound("Incidente inexistente.");
    const job = await enqueue(c, { kind: "assess_incident", entityType: "incident", entityId: item.entity_id, entityRevision: inc.rows[0].revision, territoryId: inc.rows[0].territory_id });
    return { job_id: job.id };
  }
  const r = await getReport(c, item.entity_id, { forUpdate: true });
  if (r.status === "draft") {
    const job = await enqueue(c, { kind: "evaluate_report", entityType: "report", entityId: r.id, entityRevision: r.revision, territoryId: r.territory_id });
    return { job_id: job.id };
  }
  const job = await enqueue(c, { kind: "process_report", entityType: "report", entityId: r.id, entityRevision: r.confirmed_revision!, territoryId: r.territory_id });
  const reset = await c.query("update reports set processing = 'pending', updated_at = now() where id = $1 and processing = 'error'", [r.id]);
  if (reset.rowCount) {
    await appendEvent(c, { entityType: "report", entityId: r.id, kind: "processing_retried", actorType: "operator", actorId: actor.id, data: { review_item_id: item.id } });
  }
  return { job_id: job.id };
}

async function apply(c: Db, item: Item, actor: Actor, resolution: ResolveAction, note?: string): Promise<Record<string, unknown>> {
  switch (resolution.action) {
    case "link": {
      if (!candidatesOf(item).includes(resolution.incidentId)) throw badRequest("not_a_candidate", "Ese incidente no está entre los candidatos del reporte.");
      await requireUnlinked(c, item.entity_id);
      const { linkId } = await linkReport(c, { reportId: item.entity_id, incidentId: resolution.incidentId, origin: "manual", actor });
      await moveEvaluationReviews(c, item, resolution.incidentId, actor);
      return { link_id: linkId };
    }
    case "create_incident":
      return createIncident(c, item, actor);
    case "set_type":
    case "set_severity":
      return correct(c, item, actor, resolution, note);
    case "allow_dispatch":
      return allowDispatch(c, item, actor);
    case "retry":
      return retry(c, item, actor);
    case "dismiss":
      return {};
    case "reassign":
      // No llega: `actionsFor` nunca la ofrece (no hay despacho manual a una unidad elegida en el MVP).
      throw badRequest("action_not_available", "Esa acción no está disponible para este ítem.");
  }
}

/**
 * Aplica la acción y cierra el ítem. `idempotencyKey` queda en el evento `review_resolved`, que es lo que lee el
 * reintento de `resolveReviewItemIdempotent`.
 */
async function resolveItem(
  c: Db,
  input: { reviewItemId: string; actor: Actor; resolution: ResolveAction; note?: string; idempotencyKey?: string },
): Promise<{ reviewItemId: string; status: Status }> {
  const { reviewItemId, actor, resolution, note } = input;
  const actorId = operatorId(actor);
  const territoryId = await reviewItemTerritory(c, reviewItemId);
  // El lock del pipeline: serializa contra la agrupación, las correcciones y otra resolución del mismo territorio.
  await c.query("select pg_advisory_xact_lock(hashtext($1))", [territoryId ?? `review_item:${reviewItemId}`]);
  // Incidente antes que el ítem, como `transitionAssignment` (bloquea el incidente y después abre su ítem): sin ciclo.
  await c.query(
    `select 1 from incidents where id = (
       select case when ri.entity_type = 'incident' then ri.entity_id else a.incident_id end
       from review_items ri left join assignments a on ri.entity_type = 'assignment' and a.id = ri.entity_id where ri.id = $1)
     for update`,
    [reviewItemId],
  );
  const item = (await c.query<Item>(
    "select id, territory_id, kind, entity_type, entity_id, status, evidence_refs from review_items where id = $1 for update",
    [reviewItemId],
  )).rows[0];
  if (!item) throw notFoundItem();
  if (item.status !== "open") throw conflict("review_item_closed", "Este ítem ya fue resuelto.");
  if (!actionsFor(item.kind, item.entity_type).includes(resolution.action)) {
    throw badRequest("action_not_available", "Esa acción no está disponible para este ítem.");
  }

  const effect = await apply(c, item, actor, resolution, note);

  const status: Status = resolution.action === "dismiss" ? "dismissed" : "resolved";
  const stored = { ...resolution, note: note ?? null };
  await c.query(
    "update review_items set status = $2, resolution = $3, resolved_by = $4, resolved_at = now(), updated_at = now() where id = $1",
    [item.id, status, JSON.stringify(stored), actorId],
  );
  // Después de cerrar, como pide el contrato: un ítem abierto que quede sigue bloqueando.
  await recomputeDispatchBlocked(c, await incidentsAffectedByReviewItem(c, item.id));
  await appendEvent(c, {
    entityType: item.entity_type, entityId: item.entity_id, kind: "review_resolved", actorType: "operator", actorId,
    data: { review_item_id: item.id, kind: item.kind, status, resolution: stored, effect, idempotency_key: input.idempotencyKey ?? null },
  });
  if (item.territory_id) {
    await enqueue(c, {
      kind: "plan", entityType: "territory", entityId: item.territory_id, entityRevision: 0, territoryId: item.territory_id,
      payload: { trigger: "review_resolved", review_item_id: item.id }, dedupeSuffix: `review:${item.id}`,
    });
  }
  return { reviewItemId: item.id, status };
}

/** `ResolveReviewItem` de src/server/contracts.ts. */
export const resolveReviewItem: ResolveReviewItem = (c, input) => resolveItem(c, input);

/** Forma canónica de la acción (claves ordenadas), para comparar el reintento con lo ya aplicado. */
const canonical = (r: Record<string, unknown>) => JSON.stringify(Object.keys(r).filter((k) => k !== "note").sort().map((k) => [k, r[k]]));

/**
 * La que usa la ruta: idempotente por `idempotencyKey`, con el patrón de `performOperatorAction`. Un reintento con la
 * misma clave devuelve el mismo resultado sin aplicar dos veces; con otra acción, 409 `idempotency_key_reused`.
 */
export async function resolveReviewItemIdempotent(
  c: Db,
  input: { reviewItemId: string; actor: Actor; body: ResolveBody },
): Promise<{ reviewItemId: string; status: Status; replayed: boolean }> {
  const { reviewItemId, actor, body } = input;
  const actorId = operatorId(actor);
  if (!isUuid(reviewItemId)) throw notFoundItem();
  // Serializa reintentos concurrentes con la misma clave sobre el mismo ítem (lock de dos claves).
  await c.query("select pg_advisory_xact_lock(hashtext($1), hashtext($2))", [`review_resolve:${reviewItemId}`, body.idempotencyKey]);
  const ref = (await c.query<{ entity_type: string; entity_id: string }>("select entity_type, entity_id from review_items where id = $1", [reviewItemId])).rows[0];
  if (!ref) throw notFoundItem();
  const prior = await c.query<{ data: { status: Status; resolution: Record<string, unknown> } }>(
    `select data from events
     where entity_type = $1 and entity_id = $2 and kind = 'review_resolved' and actor_type = 'operator' and actor_id = $3
       and data->>'review_item_id' = $4 and data->>'idempotency_key' = $5
     order by created_at limit 1`,
    [ref.entity_type, ref.entity_id, actorId, reviewItemId, body.idempotencyKey],
  );
  const p = prior.rows[0];
  if (p) {
    if (canonical(p.data.resolution) !== canonical(body.resolution)) throw conflict("idempotency_key_reused", "Esa clave ya se usó para otra acción.");
    return { reviewItemId, status: p.data.status, replayed: true };
  }
  const res = await resolveItem(c, { reviewItemId, actor, resolution: body.resolution, note: body.note, idempotencyKey: body.idempotencyKey });
  return { ...res, replayed: false };
}
