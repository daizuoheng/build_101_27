import { isUuid } from "../ids";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Db } from "../db/pool";
import { appendEvent } from "../events/append";
import { badRequest, conflict, DomainError, forbidden, notFound } from "../errors";
import { getActivePolicy } from "../config/policies";
import { locatePoint } from "../geo/locate";
import type { StorageAdapter } from "../storage/adapter";
import { normalizeForJev } from "../storage/normalize-image";
import type { MessageUi } from "@/shared/contracts/intake";

export type ReportRow = {
  id: string;
  citizen_session_id: string;
  territory_id: string | null;
  area_id: string | null;
  public_code: string | null;
  status: "draft" | "confirmed";
  revision: number;
  description: string | null;
  location_text: string | null;
  lon: number | null;
  lat: number | null;
  location_source: "gps" | "map" | "geocoded" | null;
  location_confirmed: boolean;
  processing: "pending" | "running" | "done" | "error";
  outcome: "applicable" | "unrelated" | "insufficient" | "out_of_coverage" | null;
  confirmed_revision: number | null;
  conversation_id: string;
  clarification_rounds: number;
};

const REPORT_SELECT = `
  select r.id, r.citizen_session_id, r.territory_id, r.area_id, r.public_code, r.status, r.revision, r.description,
         r.location_text, st_x(r.location::geometry) as lon, st_y(r.location::geometry) as lat, r.location_source,
         r.location_confirmed, r.processing, r.outcome, r.confirmed_revision, c.id as conversation_id, c.clarification_rounds
  from reports r join conversations c on c.report_id = r.id`;

export async function getReport(db: Db, reportId: string, opts: { forUpdate?: boolean } = {}): Promise<ReportRow> {
  const { rows } = await db.query<ReportRow>(`${REPORT_SELECT} where r.id = $1 ${opts.forUpdate ? "for update of r" : ""}`, [reportId]);
  if (!rows[0]) throw notFound("Reporte inexistente.");
  return rows[0];
}

/** Carga el reporte verificando que pertenezca a la sesión ciudadana (el id visible no autoriza). */
export async function getOwnedReport(db: Db, reportId: string, sessionId: string, opts: { forUpdate?: boolean } = {}) {
  if (!isUuid(reportId)) throw notFound("Reporte inexistente.");
  const r = await getReport(db, reportId, opts);
  if (r.citizen_session_id !== sessionId) throw forbidden();
  return r;
}

function assertDraft(r: ReportRow) {
  if (r.status !== "draft") throw conflict("already_confirmed", "Este reporte ya fue enviado. Abrí uno nuevo para reportar otra cosa.");
}

export async function createDraft(db: Db, { sessionId, territoryId }: { sessionId: string; territoryId: string }) {
  const { rows } = await db.query<{ id: string }>(
    "insert into reports (citizen_session_id, territory_id) values ($1, $2) returning id",
    [sessionId, territoryId],
  );
  await db.query("insert into conversations (report_id, citizen_session_id) values ($1, $2)", [rows[0].id, sessionId]);
  await appendEvent(db, { entityType: "report", entityId: rows[0].id, kind: "draft_created", actorType: "citizen", actorId: sessionId });
  return rows[0].id;
}

async function bumpRevision(db: Db, r: ReportRow): Promise<number> {
  const { rows } = await db.query<{ revision: number }>(
    "update reports set revision = revision + 1, updated_at = now() where id = $1 returning revision",
    [r.id],
  );
  await db.query("update conversations set revision = $2, updated_at = now() where id = $1", [r.conversation_id, rows[0].revision]);
  return rows[0].revision;
}

async function nextSeq(db: Db, conversationId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>("select coalesce(max(seq), 0) + 1 as n from messages where conversation_id = $1", [conversationId]);
  return rows[0].n;
}

/** Mensaje ciudadano idempotente por `clientMessageId`. Sube la revisión salvo duplicado. Llamar dentro de una transacción. */
export async function appendCitizenMessage(
  db: Db,
  { reportId, sessionId, clientMessageId, body }: { reportId: string; sessionId: string; clientMessageId: string; body: string },
): Promise<{ messageId: string; duplicate: boolean; revision: number }> {
  const r = await getOwnedReport(db, reportId, sessionId, { forUpdate: true });
  assertDraft(r);
  const dup = await db.query<{ id: string }>(
    "select id from messages where conversation_id = $1 and client_message_id = $2",
    [r.conversation_id, clientMessageId],
  );
  if (dup.rows[0]) return { messageId: dup.rows[0].id, duplicate: true, revision: r.revision };
  const seq = await nextSeq(db, r.conversation_id);
  const { rows } = await db.query<{ id: string }>(
    `insert into messages (conversation_id, seq, role, body, origin, client_message_id) values ($1, $2, 'citizen', $3, 'human', $4) returning id`,
    [r.conversation_id, seq, body, clientMessageId],
  );
  // La descripción del reporte es el relato ciudadano original concatenado; nunca una paráfrasis del LLM.
  await db.query(
    "update reports set description = coalesce(description || E'\\n', '') || $2 where id = $1",
    [r.id, body],
  );
  const revision = await bumpRevision(db, r);
  return { messageId: rows[0].id, duplicate: false, revision };
}

/**
 * Saca de la descripción un mensaje que no es relato del problema (una respuesta corta como «sí» o «enviar», una
 * consulta de estado o una dirección escrita en respuesta a un pedido de ubicación). El mensaje queda en la
 * conversación; solo deja de formar parte de la descripción que ven la ficha, Jev al procesar y la unidad.
 * Solo quita la última línea si es exactamente ese texto (es lo que agregó `appendCitizenMessage`).
 */
export async function excludeFromDescription(db: Db, reportId: string, body: string): Promise<void> {
  await db.query(
    `update reports set description = nullif(case
       when description = $2 then ''
       when right(description, length($2) + 1) = E'\\n' || $2 then left(description, length(description) - length($2) - 1)
       else description end, '')
     where id = $1`,
    [reportId, body],
  );
}

/**
 * Respuesta de control («sí», «no», «enviar», una consulta de estado): sale de la descripción y además se marca
 * para que deje de ser evidencia de Jev y del LLM (si no, un «sí» llega como relato a la próxima evaluación).
 */
export async function consumeControlReply(db: Db, reportId: string, msg: { id: string; body: string }): Promise<void> {
  await db.query("update messages set control_reply = true where id = $1", [msg.id]);
  await excludeFromDescription(db, reportId, msg.body);
}

export async function appendAssistantMessage(
  db: Db,
  { conversationId, body, origin, ui, llmRunId }: { conversationId: string; body: string; origin: "template" | "llm"; ui?: MessageUi | null; llmRunId?: string | null },
): Promise<string> {
  const seq = await nextSeq(db, conversationId);
  const { rows } = await db.query<{ id: string }>(
    `insert into messages (conversation_id, seq, role, body, origin, ui, llm_run_id) values ($1, $2, 'assistant', $3, $4, $5, $6) returning id`,
    [conversationId, seq, body, origin, ui ? JSON.stringify(ui) : null, llmRunId ?? null],
  );
  return rows[0].id;
}

/**
 * Foto: guarda el original privado y un derivado normalizado para Jev, ambos con sha256.
 * Formato que no se puede convertir ⇒ error claro pidiendo otra foto.
 */
export async function attachPhoto(
  db: Db,
  storage: StorageAdapter,
  { reportId, sessionId, clientMessageId, bytes, contentType }: { reportId: string; sessionId: string; clientMessageId: string; bytes: Buffer; contentType: string },
): Promise<{ duplicate: boolean; revision: number }> {
  const r = await getOwnedReport(db, reportId, sessionId, { forUpdate: true });
  assertDraft(r);
  const dup = await db.query("select 1 from messages where conversation_id = $1 and client_message_id = $2", [r.conversation_id, clientMessageId]);
  if (dup.rows[0]) return { duplicate: true, revision: r.revision };

  const intake = await getActivePolicy(db, r.territory_id!, "intake");
  if (bytes.length > intake.config.photo.max_bytes) throw new DomainError("photo_too_large", 413, "La foto es muy pesada. Probá con otra o sacala de nuevo.");

  let original: { width?: number; height?: number };
  let derived;
  try {
    original = await sharp(bytes).metadata();
    derived = await normalizeForJev(bytes);
  } catch {
    throw new DomainError("unsupported_image", 415, "No pude leer esa imagen. Probá con una foto JPG o PNG (en iPhone: Ajustes › Cámara › Formatos › Más compatible).");
  }

  const seq = await nextSeq(db, r.conversation_id);
  const msg = await db.query<{ id: string }>(
    `insert into messages (conversation_id, seq, role, body, origin, client_message_id) values ($1, $2, 'citizen', '[foto]', 'human', $3) returning id`,
    [r.conversation_id, seq, clientMessageId],
  );
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const baseKey = `reports/${r.id}/${randomUUID()}`;
  await storage.put(`${baseKey}-original`, bytes, contentType);
  await storage.put(`${baseKey}-jev.jpg`, derived.bytes, "image/jpeg");
  const orig = await db.query<{ id: string }>(
    `insert into attachments (report_id, message_id, storage_key, content_type, bytes, sha256, width, height, purpose)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'original') returning id`,
    [r.id, msg.rows[0].id, `${baseKey}-original`, contentType, bytes.length, sha(bytes), original.width ?? null, original.height ?? null],
  );
  await db.query(
    `insert into attachments (report_id, message_id, storage_key, content_type, bytes, sha256, width, height, derived_from_id, purpose)
     values ($1, $2, $3, 'image/jpeg', $4, $5, $6, $7, $8, 'jev')`,
    [r.id, msg.rows[0].id, `${baseKey}-jev.jpg`, derived.bytes.length, sha(derived.bytes), derived.width, derived.height, orig.rows[0].id],
  );
  return { duplicate: false, revision: await bumpRevision(db, r) };
}

/** Ubicación confirmada explícitamente por la persona. El territorio/área se resuelven por PostGIS. */
export async function setLocation(
  db: Db,
  { reportId, sessionId, lon, lat, source, text }: { reportId: string; sessionId: string; lon: number; lat: number; source: "gps" | "map" | "geocoded"; text?: string },
): Promise<{ revision: number; inCoverage: boolean }> {
  const r = await getOwnedReport(db, reportId, sessionId, { forUpdate: true });
  assertDraft(r);
  const located = await locatePoint(db, lon, lat);
  const inCoverage = !!located && located.territoryId === r.territory_id;
  await db.query(
    `update reports set location = st_setsrid(st_makepoint($2, $3), 4326)::geography, location_source = $4,
       location_text = coalesce($5, location_text), location_confirmed = true, area_id = $6, updated_at = now()
     where id = $1`,
    [r.id, lon, lat, source, text ?? null, inCoverage ? located!.areaId : null],
  );
  await appendEvent(db, { entityType: "report", entityId: r.id, kind: "location_confirmed", actorType: "citizen", actorId: sessionId, data: { source, inCoverage } });
  return { revision: await bumpRevision(db, r), inCoverage };
}

export function requireTerritory(r: ReportRow): string {
  if (!r.territory_id) throw badRequest("no_territory", "El reporte no tiene territorio.");
  return r.territory_id;
}

/** Evidencia que Jev recibe: mensajes ciudadanos originales (sin respuestas de control) y derivados de fotos (no paráfrasis del LLM). */
export async function loadEvidence(db: Db, storage: StorageAdapter, reportId: string) {
  const msgs = await db.query<{ id: string; body: string; created_at: Date }>(
    `select m.id, m.body, m.created_at from messages m join conversations c on c.id = m.conversation_id
     where c.report_id = $1 and m.role = 'citizen' and m.body <> '[foto]' and not m.control_reply order by m.seq`,
    [reportId],
  );
  const atts = await db.query<{ id: string; storage_key: string }>(
    "select id, storage_key from attachments where report_id = $1 and purpose = 'jev' order by created_at",
    [reportId],
  );
  const images = await Promise.all(
    atts.rows.map(async (a) => ({ attachmentId: a.id, bytes: await storage.get(a.storage_key), format: "jpeg" as const })),
  );
  return {
    messages: msgs.rows.map((m) => ({ id: m.id, body: m.body, createdAt: m.created_at.toISOString() })),
    images,
  };
}

export async function areaName(db: Db, areaId: string | null): Promise<string | null> {
  if (!areaId) return null;
  const { rows } = await db.query<{ name: string }>("select name from areas where id = $1", [areaId]);
  return rows[0]?.name ?? null;
}
