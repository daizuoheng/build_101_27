// Pedidos del operador desde el detalle del incidente (corregir, quitar corrección, asociar y desasociar reportes),
// idempotentes por `idempotencyKey` con el patrón de `performOperatorAction` (src/server/dispatch/operator-action.ts):
// lock de dos claves, el resultado queda en `events` (`operator_request`, con `data.idempotency_key`) y un reintento
// con la misma clave devuelve lo mismo sin volver a aplicar; con otro pedido ⇒ 409 `idempotency_key_reused`.

import type { PoolClient } from "pg";
import type { InternalSession } from "../access/internal-session";
import type { Db } from "../db/pool";
import { badRequest, conflict, notFound } from "../errors";
import { appendEvent } from "../events/append";
import { isUuid } from "../ids";
import { OVERRIDE_FIELDS, type LinkBody, type OverrideField, type SetOverrideBody } from "@/shared/contracts/incident";
import type { LinkResult, OverrideResult } from "@/shared/contracts/incident-detail";
import { linkReport, unlinkReport } from "./links";
import { removeOverride, setOverride } from "./overrides";

/**
 * Territorio del incidente, si es del operador de la sesión. Un id que no es uuid, inexistente o de otro territorio
 * da el mismo 404: la respuesta no revela qué incidentes existen en otros territorios.
 */
export async function operatorIncidentTerritory(db: Db, s: InternalSession, incidentId: string): Promise<string> {
  if (!isUuid(incidentId)) throw notFound("Incidente inexistente.");
  const { rows } = await db.query<{ territory_id: string }>("select territory_id from incidents where id = $1", [incidentId]);
  if (!rows[0] || rows[0].territory_id !== s.territoryId) throw notFound("Incidente inexistente.");
  return rows[0].territory_id;
}

/** JSON con las claves ordenadas: jsonb no conserva el orden, y el pedido guardado se compara con el nuevo. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

async function idempotent<T extends object>(
  c: PoolClient,
  i: { incidentId: string; userId: string; key: string; request: Record<string, unknown> },
  run: () => Promise<T>,
): Promise<T & { replayed: boolean }> {
  // Serializa reintentos concurrentes con la misma clave sobre el mismo incidente.
  await c.query("select pg_advisory_xact_lock(hashtext($1), hashtext($2))", [`operator_request:${i.incidentId}`, i.key]);
  const prior = await c.query<{ data: { request: unknown; result: T } }>(
    `select data from events
     where entity_type = 'incident' and entity_id = $1 and kind = 'operator_request' and actor_type = 'operator'
       and actor_id = $2 and data->>'idempotency_key' = $3
     order by created_at limit 1`,
    [i.incidentId, i.userId, i.key],
  );
  const p = prior.rows[0];
  if (p) {
    if (canonical(p.data.request) !== canonical(i.request)) throw conflict("idempotency_key_reused", "Esa clave ya se usó para otro pedido.");
    return { ...p.data.result, replayed: true };
  }
  const result = await run();
  await appendEvent(c, {
    entityType: "incident", entityId: i.incidentId, kind: "operator_request", actorType: "operator", actorId: i.userId,
    data: { idempotency_key: i.key, request: i.request, result },
  });
  return { ...result, replayed: false };
}

const operator = (userId: string) => ({ type: "operator" as const, id: userId });

/** POST …/overrides: corrección por campo con la revisión que vio el operador (si cambió ⇒ 409 `revision_conflict`). */
export async function requestSetOverride(c: PoolClient, i: { incidentId: string; userId: string; body: SetOverrideBody }): Promise<OverrideResult> {
  const { idempotencyKey, ...request } = i.body;
  return idempotent(c, { incidentId: i.incidentId, userId: i.userId, key: idempotencyKey, request: { op: "set_override", ...request } }, () =>
    setOverride(c, { incidentId: i.incidentId, override: request.override, reason: request.reason, actor: operator(i.userId), expectedRevision: request.expectedRevision }),
  );
}

/** DELETE …/overrides/[field]: vuelve a mandar lo evaluado por la IA para ese campo. */
export async function requestRemoveOverride(
  c: PoolClient,
  i: { incidentId: string; userId: string; field: string; idempotencyKey: string },
): Promise<OverrideResult> {
  if (!(OVERRIDE_FIELDS as readonly string[]).includes(i.field)) throw badRequest("invalid_field", "Ese campo no se puede corregir.");
  const field = i.field as OverrideField;
  return idempotent(c, { incidentId: i.incidentId, userId: i.userId, key: i.idempotencyKey, request: { op: "remove_override", field } }, () =>
    removeOverride(c, { incidentId: i.incidentId, field, actor: operator(i.userId) }),
  );
}

/**
 * POST …/links: asociar un reporte confirmado del territorio a este incidente (si estaba en otro, se mueve), o
 * desasociar uno que esté vinculado a este incidente (si no, 404: desde acá no se tocan vínculos de otros incidentes).
 */
export async function requestLink(c: PoolClient, i: { incidentId: string; userId: string; body: LinkBody }): Promise<LinkResult> {
  const { idempotencyKey, ...request } = i.body;
  const actor = operator(i.userId);
  return idempotent<Omit<LinkResult, "replayed">>(c, { incidentId: i.incidentId, userId: i.userId, key: idempotencyKey, request: { op: "link", ...request } }, async () => {
    if (request.action === "link") {
      const r = await linkReport(c, { reportId: request.reportId, incidentId: i.incidentId, origin: "manual", actor });
      return { action: "link", incidentId: i.incidentId, reportId: request.reportId, previousIncidentId: r.previousIncidentId };
    }
    // Bajo el lock del territorio (el mismo que toma unlinkReport, reentrante): el vínculo no se mueve entre el chequeo y el cambio.
    const t = await c.query<{ territory_id: string }>("select territory_id from incidents where id = $1", [i.incidentId]);
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [t.rows[0].territory_id]);
    const linked = await c.query("select 1 from report_incident_links where report_id = $1 and incident_id = $2 and active", [request.reportId, i.incidentId]);
    if (!linked.rows[0]) throw notFound("Ese reporte no está asociado a este incidente.");
    const r = await unlinkReport(c, { reportId: request.reportId, reason: request.reason, actor });
    return { action: "unlink", incidentId: i.incidentId, reportId: request.reportId, archived: r.archived };
  }) as Promise<LinkResult>;
}
