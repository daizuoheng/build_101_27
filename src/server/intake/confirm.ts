import { randomInt } from "node:crypto";
import type { PoolClient } from "pg";
import { renderTemplate } from "../config/templates";
import { badRequest } from "../errors";
import { appendEvent } from "../events/append";
import { enqueue } from "../jobs/queue";
import { appendAssistantMessage, getOwnedReport } from "./drafts";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0/O/1/I

const DIGITS = "23456789";

/** 6 caracteres con al menos un dígito: así un código no se confunde con una palabra en mayúsculas («CALLES»). */
export function newCode(): string {
  const chars = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  if (!chars.some((c) => DIGITS.includes(c))) chars[randomInt(6)] = DIGITS[randomInt(DIGITS.length)];
  return chars.join("");
}

/**
 * Confirma el envío en una transacción: fija la revisión, asigna código y crea el job único de procesamiento.
 * Reintentos (misma clave o no) devuelven el mismo código y no crean otro job.
 */
export async function confirmReport(
  c: PoolClient,
  { reportId, sessionId, idempotencyKey }: { reportId: string; sessionId: string; idempotencyKey: string },
): Promise<{ publicCode: string; jobId: string; alreadyConfirmed: boolean }> {
  const r = await getOwnedReport(c, reportId, sessionId, { forUpdate: true });
  if (r.status === "confirmed") {
    // Reintento: si el procesamiento había fallado, `enqueue` revive el job y el reporte vuelve a pendiente.
    const job = await enqueue(c, { kind: "process_report", entityType: "report", entityId: r.id, entityRevision: r.confirmed_revision!, territoryId: r.territory_id });
    if (job.revived) {
      await c.query("update reports set processing = 'pending', updated_at = now() where id = $1 and processing = 'error'", [r.id]);
      await appendEvent(c, { entityType: "report", entityId: r.id, kind: "processing_retried", actorType: "citizen", actorId: sessionId });
    }
    return { publicCode: r.public_code!, jobId: job.id, alreadyConfirmed: true };
  }
  if (!r.description?.trim()) throw badRequest("description_required", "Contame qué pasó antes de enviar.");
  if (!r.location_confirmed) throw badRequest("location_required", "Confirmá dónde está el problema antes de enviar.");

  let code = newCode();
  for (let i = 0; ; i++) {
    const taken = await c.query("select 1 from reports where public_code = $1", [code]);
    if (!taken.rows[0]) break;
    if (i > 10) throw new Error("no se pudo generar un código único");
    code = newCode();
  }
  await c.query(
    `update reports set status = 'confirmed', public_code = $2, confirmed_at = now(), confirmed_revision = revision,
       confirm_key = $3, processing = 'pending', updated_at = now() where id = $1`,
    [r.id, code, idempotencyKey],
  );
  const job = await enqueue(c, { kind: "process_report", entityType: "report", entityId: r.id, entityRevision: r.revision, territoryId: r.territory_id });
  await appendAssistantMessage(c, {
    conversationId: r.conversation_id,
    body: await renderTemplate(c, r.territory_id, "confirmation", { code }),
    origin: "template",
    ui: { kind: "confirmed", publicCode: code },
  });
  await appendEvent(c, { entityType: "report", entityId: r.id, kind: "confirmed", actorType: "citizen", actorId: sessionId, data: { revision: r.revision, public_code: code } });
  return { publicCode: code, jobId: job.id, alreadyConfirmed: false };
}
