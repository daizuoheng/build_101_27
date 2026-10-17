import type { Pool, PoolClient } from "pg";
import { withTx } from "../db/tx";
import { getActiveCatalog } from "../config/catalog";
import { getActivePolicy } from "../config/policies";
import { renderTemplate } from "../config/templates";
import type { JevClient } from "../ai/jev/client";
import { evaluateReport } from "../ai/jev/evaluate-report";
import type { LlmClient } from "../ai/llm/client";
import { extractAddress } from "../ai/llm/extract-address";
import { clarify } from "../ai/llm/clarify";
import { interpretCorrection } from "../ai/llm/interpret-correction";
import { recordAiRun, recordLlmRun } from "../ai/runs";
import { geocode } from "../geo/geocoder";
import { enqueue } from "../jobs/queue";
import type { StorageAdapter } from "../storage/adapter";
import { appendAssistantMessage, areaName, excludeFromDescription, getReport, loadEvidence, setLocation, type ReportRow } from "./drafts";
import { confirmReport } from "./confirm";
import { classifyReply, extractPublicCode, isOnlyAddress } from "./replies";
import { appendEvent } from "../events/append";
import { DomainError } from "../errors";
import { chooseBranch, evidenceReasons, indicatesActiveHazard, type Branch } from "./branches";
import { getEvaluation, saveReportEvaluation, type StoredEvaluation } from "./evaluations";
import { statusLabel } from "./status";
import type { AiResult } from "@/shared/contracts/evaluation";
import type { MessageUi } from "@/shared/contracts/intake";

export type IntakeDeps = { pool: Pool; jev: JevClient; llm: LlmClient | null; storage: StorageAdapter };

/**
 * Evalúa con Jev la revisión indicada (o reutiliza la evaluación ya guardada) y la persiste.
 * `timeoutMs` acota la espera sincrónica en el chat; el worker usa el timeout de la política.
 */
export async function evaluateRevision(
  deps: IntakeDeps,
  reportId: string,
  revision: number,
  opts: { timeoutMs?: number; requireCurrentConfig?: boolean } = {},
): Promise<AiResult<StoredEvaluation>> {
  const r = await getReport(deps.pool, reportId);
  if (r.revision !== revision) return { ok: false, error: { kind: "invalid", message: "revisión obsoleta" } };
  const territoryId = r.territory_id!;
  const policy = await getActivePolicy(deps.pool, territoryId, "evaluation");
  const catalog = await getActiveCatalog(deps.pool, territoryId);

  // Reutiliza la evaluación de la recepción solo si coinciden revisión, catálogo y política (o si no se exige).
  const existing = await getEvaluation(deps.pool, reportId, revision);
  const current = existing && existing.catalogHash === catalog.hash && existing.policyVersionId === policy.id;
  if (existing && (current || !opts.requireCurrentConfig)) return { ok: true, value: existing, aiRunId: existing.aiRunId };
  const evidence = await loadEvidence(deps.pool, deps.storage, reportId);
  const timeout = opts.timeoutMs ? Math.min(opts.timeoutMs, policy.config.timeout_ms) : policy.config.timeout_ms;

  const res = await evaluateReport(
    {
      reportId,
      reportRevision: revision,
      messages: evidence.messages,
      images: evidence.images,
      location: { confirmed: r.location_confirmed, text: r.location_text, areaName: await areaName(deps.pool, r.area_id) },
      catalog: catalog.types,
      catalogHash: catalog.hash,
      policy: { ...policy, config: { ...policy.config, timeout_ms: timeout } },
    },
    { jev: deps.jev, recordRun: (run) => recordAiRun(deps.pool, run) },
  );
  if (!res.ok) return res;
  await saveReportEvaluation(deps.pool, {
    reportId, reportRevision: revision, aiRunId: res.aiRunId, policyVersionId: policy.id, catalogHash: catalog.hash, ev: res.value,
    replace: !!existing,
  });
  return { ok: true, aiRunId: res.aiRunId, value: (await getEvaluation(deps.pool, reportId, revision))! };
}

/** Turno de recepción tras persistir una entrada ciudadana: Jev primero; si no llega a tiempo, queda en el worker. */
export async function runIntakeTurn(deps: IntakeDeps, reportId: string): Promise<void> {
  const r0 = await getReport(deps.pool, reportId);
  if (r0.status !== "draft") return;
  const intake = await getActivePolicy(deps.pool, r0.territory_id!, "intake");
  // Respuestas por texto a una pregunta concreta (canales sin botones) y consultas por código: antes de Jev.
  const short = await handleShortReply(deps, r0, intake.config);
  if (short === "handled") return;
  const r = short === "continue" ? await getReport(deps.pool, reportId) : r0;
  if (r.status !== "draft") return;
  const res = await evaluateRevision(deps, reportId, r.revision, { timeoutMs: intake.config.jev_timeout_ms });
  if (res.ok) return respondToEvaluation(deps, reportId, r.revision, res.value);

  await withTx(async (c) => {
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [reportId]);
    const cur = await getReport(c, reportId);
    if (cur.revision !== r.revision) return; // llegó una entrada nueva: ese turno responde
    const pending = await c.query(
      "select 1 from jobs where kind = 'evaluate_report' and entity_id = $1 and entity_revision = $2",
      [reportId, r.revision],
    );
    if (!pending.rows[0]) {
      await appendAssistantMessage(c, { conversationId: cur.conversation_id, body: await renderTemplate(c, cur.territory_id, "pending_analysis"), origin: "template" });
    }
    await enqueue(c, { kind: "evaluate_report", entityType: "report", entityId: reportId, entityRevision: r.revision, territoryId: cur.territory_id });
  }, deps.pool);
}

type Reply = { body: string; origin: "template" | "llm"; ui: MessageUi | null; llmRunId?: string | null };

/** Responde ya, sin evaluación, a la revisión actual (bajo el lock del reporte). Devuelve false si llegó otra entrada. */
async function replyNow(c: PoolClient, r: ReportRow, reply: Reply, strip?: string): Promise<boolean> {
  await c.query("select pg_advisory_xact_lock(hashtext($1))", [r.id]);
  const cur = await c.query<{ revision: number; status: string }>("select revision, status from reports where id = $1", [r.id]);
  if (cur.rows[0].status !== "draft" || cur.rows[0].revision !== r.revision) return false;
  if (strip) await excludeFromDescription(c, r.id, strip);
  await appendAssistantMessage(c, { conversationId: r.conversation_id, ...reply });
  await c.query("update conversations set replied_revision = greatest(replied_revision, $2), updated_at = now() where id = $1", [r.conversation_id, r.revision]);
  return true;
}

/**
 * El mensaje que disparó el turno, si es un texto ciudadano, junto con la última pregunta del asistente con UI
 * (ignorando avisos). Solo cuenta si el texto llegó después de esa pregunta.
 */
async function lastExchange(db: Pool, conversationId: string) {
  const { rows } = await db.query<{ id: string; body: string; role: string; asked: MessageUi | null; asked_seq: number | null; seq: number }>(
    `select m.id, m.body, m.role, m.seq,
       (select ui from messages a where a.conversation_id = $1 and a.role = 'assistant' and a.ui is not null
          and a.ui->>'kind' not in ('active_hazard', 'status') order by a.seq desc limit 1) as asked,
       (select seq from messages a where a.conversation_id = $1 and a.role = 'assistant' and a.ui is not null
          and a.ui->>'kind' not in ('active_hazard', 'status') order by a.seq desc limit 1) as asked_seq
     from messages m where m.conversation_id = $1 order by m.seq desc limit 1`,
    [conversationId],
  );
  const m = rows[0];
  if (!m || m.role !== "citizen" || m.body === "[foto]") return null;
  return { messageId: m.id, text: m.body, asked: m.asked_seq !== null && m.asked_seq < m.seq ? m.asked : null };
}

/**
 * Respuestas cortas por texto, equivalentes a los botones de la web, para canales que no los tienen:
 * - pin propuesto + «sí» ⇒ la persona confirma esa ubicación (sigue el turno normal con Jev sobre la nueva revisión);
 * - pin propuesto + «no» ⇒ se le pide otra dirección;
 * - ficha lista + «enviar»/«sí» ⇒ se envía el reporte (misma confirmación idempotente que el botón);
 * - un código de reporte ⇒ estado de ese reporte, con tope de consultas por sesión.
 * Todo lo demás sigue el flujo normal. El LLM no interviene en ninguna de estas decisiones.
 */
async function handleShortReply(deps: IntakeDeps, r: ReportRow, intake: IntakeConfig): Promise<"handled" | "continue" | null> {
  const ex = await lastExchange(deps.pool, r.conversation_id);
  if (!ex) return null;
  const t = (key: string, vars?: Record<string, string>) => renderTemplate(deps.pool, r.territory_id, key, vars);

  // Solo mensajes cortos: un código suelto dentro de un relato largo no es una consulta de estado.
  const code = intake.status_lookup && ex.text.length <= 80 ? extractPublicCode(ex.text) : null;
  if (code && intake.status_lookup) {
    const body = await statusByCode(deps.pool, { sessionId: r.citizen_session_id, territoryId: r.territory_id!, code, max: intake.status_lookup.max_per_hour }, t);
    await withTx((c) => replyNow(c, r, { body, origin: "template", ui: { kind: "status" } }, ex.text), deps.pool);
    return "handled";
  }

  if (!intake.replies || !ex.asked) return null;
  const kind = classifyReply(ex.text, intake.replies);
  if (!kind) return null;

  if (ex.asked.kind === "propose_location") {
    const p = ex.asked;
    const alreadyThere = r.location_confirmed && r.lon !== null && Math.abs(r.lon - p.lon) < 1e-6 && Math.abs(r.lat! - p.lat) < 1e-6;
    if (alreadyThere) return null;
    if (kind === "no") {
      await withTx(async (c) => replyNow(c, r, { body: await t("ask_location_retry"), origin: "template", ui: { kind: "ask_location" } }, ex.text), deps.pool);
      return "handled";
    }
    await withTx(async (c) => {
      await excludeFromDescription(c, r.id, ex.text);
      await setLocation(c, { reportId: r.id, sessionId: r.citizen_session_id, lon: p.lon, lat: p.lat, source: "geocoded", text: p.label });
    }, deps.pool);
    return "continue";
  }

  if (ex.asked.kind === "ready" && (kind === "send" || kind === "yes")) {
    try {
      await withTx(async (c) => {
        await c.query("select 1 from reports where id = $1 for update", [r.id]);
        await excludeFromDescription(c, r.id, ex.text);
        await confirmReport(c, { reportId: r.id, sessionId: r.citizen_session_id, idempotencyKey: `reply:${ex.messageId}` });
      }, deps.pool);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
      await withTx((c) => replyNow(c, r, { body: err.message, origin: "template", ui: null }), deps.pool);
    }
    return "handled";
  }
  return null;
}

/** Estado de un reporte por su código público: solo el estado, nunca datos del reporte ni de quien lo envió. */
async function statusByCode(
  db: Pool,
  { sessionId, territoryId, code, max }: { sessionId: string; territoryId: string; code: string; max: number },
  t: (key: string, vars?: Record<string, string>) => Promise<string>,
): Promise<string> {
  const used = await db.query<{ n: number }>(
    `select count(*)::int as n from events where kind = 'status_lookup' and actor_type = 'citizen' and actor_id = $1
       and created_at > now() - interval '1 hour'`,
    [sessionId],
  );
  if (used.rows[0].n >= max) return t("status_rate_limited");
  const { rows } = await db.query<{ processing: string; outcome: string | null; incident_status: string | null }>(
    `select r.processing, r.outcome, i.status as incident_status
     from reports r
     left join report_incident_links l on l.report_id = r.id and l.active
     left join incidents i on i.id = l.incident_id
     where r.public_code = $1 and r.territory_id = $2 and r.status = 'confirmed'`,
    [code, territoryId],
  );
  await appendEvent(db, { entityType: "citizen_session", entityId: sessionId, kind: "status_lookup", actorType: "citizen", actorId: sessionId, data: { found: !!rows[0] } });
  const x = rows[0];
  if (!x) return t("status_not_found", { code });
  return t("status_card", { code, status: statusLabel(x.processing as never, x.outcome as never, x.incident_status as never) });
}

/** Responde a la persona según la rama. Las llamadas de red (LLM, geocodificador) se hacen fuera de la transacción. */
export async function respondToEvaluation(deps: IntakeDeps, reportId: string, revision: number, ev: StoredEvaluation): Promise<void> {
  const r = await getReport(deps.pool, reportId);
  if (r.status !== "draft" || r.revision !== revision) return;
  const territoryId = r.territory_id!;
  const intake = await getActivePolicy(deps.pool, territoryId, "intake");
  const answering = await answeringLocation(deps.pool, r.conversation_id);
  let strip: string | null = null;
  const branch = chooseBranch(
    ev,
    {
      locationConfirmed: r.location_confirmed,
      textAfterReady: (await textsAfterReady(deps.pool, r.conversation_id)).length > 0,
      answeringLocation: answering,
    },
    intake.config,
    r.clarification_rounds,
  );
  const t = (key: string, vars?: Record<string, string>) => renderTemplate(deps.pool, territoryId, key, vars);
  const pending = await pendingProposal(deps.pool, r.id, r.conversation_id);
  // Con un pin de corrección sin confirmar, la ficha lista mostraría la dirección vieja: se vuelve a ofrecer el pin.
  const ready = async (): Promise<Reply> =>
    pending
      ? { body: await t("location_proposed", { label: pending.label }), origin: "template", ui: pending }
      : { body: await readyText(deps.pool, r, ev, t), origin: "template", ui: { kind: "ready" } };

  let reply: Reply;
  switch (branch.kind) {
    case "orient":
      reply = { body: await t("greeting_other"), origin: "template", ui: null };
      break;
    case "status": {
      // Jev dice que es una consulta de estado: si menciona un código, se responde por ese código (cualquier frase);
      // si no, los últimos reportes de esta sesión. El mensaje no es relato, así que sale de la descripción.
      const ex = await lastExchange(deps.pool, r.conversation_id);
      const code = ex && intake.config.status_lookup ? extractPublicCode(ex.text, { requireQueryOnly: false }) : null;
      const body = code
        ? await statusByCode(deps.pool, { sessionId: r.citizen_session_id, territoryId, code, max: intake.config.status_lookup!.max_per_hour }, t)
        : await statusSummary(deps.pool, r.citizen_session_id, territoryId);
      reply = { body, origin: "template", ui: { kind: "status" } };
      if (ex) strip = ex.text;
      break;
    }
    case "ask_location":
      reply = { body: await t("ask_location"), origin: "template", ui: { kind: "ask_location" } };
      break;
    case "extract_address": {
      const res = await proposeAddress(deps, r.id, revision, territoryId, intake.config, t);
      reply = res.reply;
      // Una dirección escrita en respuesta al pedido de ubicación es dato de ubicación, no relato del problema.
      const ex = answering && res.address ? await lastExchange(deps.pool, r.conversation_id) : null;
      if (ex && isOnlyAddress(ex.text, res.address!)) strip = ex.text;
      break;
    }
    case "ask_evidence":
      reply = await askEvidence(deps, r.id, revision, ev, branch.requestedField, intake.config, t);
      break;
    case "interpret_correction":
      reply = await proposeCorrection(deps, r, revision, intake.config, t, ready);
      break;
    case "ready":
      reply = await ready();
      break;
  }

  const hazard = indicatesActiveHazard(ev);
  const territory = hazard
    ? (await deps.pool.query<{ emergency_channel: { text?: string } }>("select emergency_channel from territories where id = $1", [territoryId])).rows[0]
    : null;

  await withTx(async (c) => {
    await c.query("select pg_advisory_xact_lock(hashtext($1))", [reportId]);
    const cur = await c.query<{ revision: number; status: string; replied_revision: number; conversation_id: string }>(
      `select r.revision, r.status, c.replied_revision, c.id as conversation_id
       from reports r join conversations c on c.report_id = r.id where r.id = $1`,
      [reportId],
    );
    const row = cur.rows[0];
    if (row.status !== "draft" || row.revision !== revision || row.replied_revision >= revision) return;

    if (hazard) {
      const already = await c.query("select 1 from messages where conversation_id = $1 and ui->>'kind' = 'active_hazard'", [row.conversation_id]);
      if (!already.rows[0]) {
        await appendAssistantMessage(c, {
          conversationId: row.conversation_id,
          body: await renderTemplate(c, territoryId, "active_hazard_notice", { emergency: territory?.emergency_channel?.text ?? "" }),
          origin: "template",
          ui: { kind: "active_hazard" },
        });
      }
    }
    if (strip) await excludeFromDescription(c, reportId, strip);
    await appendAssistantMessage(c, { conversationId: row.conversation_id, ...reply });
    await c.query(
      `update conversations set replied_revision = $2, clarification_rounds = clarification_rounds + $3, updated_at = now() where id = $1`,
      [row.conversation_id, revision, branch.kind === "ask_evidence" ? 1 : 0],
    );
  }, deps.pool);
}

type IntakeConfig = Awaited<ReturnType<typeof getActivePolicy<"intake">>>["config"];
type Render = (key: string, vars?: Record<string, string>) => Promise<string>;

/** Mensajes de texto del ciudadano (evidencia original), en orden. */
async function citizenTexts(db: Pool, reportId: string): Promise<{ id: string; body: string }[]> {
  const { rows } = await db.query<{ id: string; body: string }>(
    `select m.id, m.body from messages m join conversations c on c.id = m.conversation_id
     where c.report_id = $1 and m.role = 'citizen' and m.body <> '[foto]' order by m.seq`,
    [reportId],
  );
  return rows;
}

/**
 * Textos del ciudadano posteriores a la última ficha lista (o al último pin propuesto después de ella):
 * candidatos a corrección. Antes de la primera ficha lista no hay nada que corregir.
 */
async function textsAfterReady(db: Pool, conversationId: string): Promise<{ id: string; body: string }[]> {
  const { rows } = await db.query<{ id: string; body: string }>(
    `select m.id, m.body from messages m
     where m.conversation_id = $1 and m.role = 'citizen' and m.body <> '[foto]'
       and exists (select 1 from messages where conversation_id = $1 and role = 'assistant' and ui->>'kind' = 'ready')
       and m.seq > (select max(seq) from messages where conversation_id = $1 and role = 'assistant' and ui->>'kind' in ('ready', 'propose_location'))
     order by m.seq`,
    [conversationId],
  );
  return rows;
}

/**
 * La persona respondió con texto a un pedido (o propuesta) de ubicación: el último mensaje del asistente con UI es
 * `ask_location`/`propose_location` y hay un texto ciudadano posterior. Señal estructural, no del LLM.
 */
async function answeringLocation(db: Pool, conversationId: string): Promise<boolean> {
  const { rows } = await db.query(
    `with last_ui as (
       select seq, ui->>'kind' as kind from messages
       where conversation_id = $1 and role = 'assistant' and ui is not null and ui->>'kind' not in ('active_hazard', 'status')
       order by seq desc limit 1)
     select 1 from last_ui l
     where l.kind in ('ask_location', 'propose_location')
       and exists (select 1 from messages m where m.conversation_id = $1 and m.role = 'citizen' and m.body <> '[foto]' and m.seq > l.seq)`,
    [conversationId],
  );
  return rows.length > 0;
}

const llmDeps = (deps: IntakeDeps) => ({ llm: deps.llm!, recordRun: (run: Parameters<typeof recordLlmRun>[1]) => recordLlmRun(deps.pool, run) });

type ProposedLocation = Extract<MessageUi, { kind: "propose_location" }>;

/**
 * Pin de corrección pendiente: el último `propose_location` posterior a una ficha lista, sin una confirmación de
 * ubicación posterior (la persona no lo aceptó ni eligió otro punto). Antes de la primera ficha lista no aplica:
 * ahí la ubicación todavía no está confirmada y manda la rama `ask_location`/`extract_address`.
 */
async function pendingProposal(db: Pool, reportId: string, conversationId: string): Promise<ProposedLocation | null> {
  const { rows } = await db.query<{ ui: ProposedLocation }>(
    `select p.ui from messages p
     where p.conversation_id = $1 and p.role = 'assistant' and p.ui->>'kind' = 'propose_location'
       and p.seq > (select max(seq) from messages where conversation_id = $1 and role = 'assistant' and ui->>'kind' = 'ready')
       and not exists (select 1 from events e where e.entity_type = 'report' and e.entity_id = $2
                       and e.kind = 'location_confirmed' and e.created_at > p.created_at)
     order by p.seq desc limit 1`,
    [conversationId, reportId],
  );
  return rows[0]?.ui ?? null;
}

/**
 * Geocodifica una dirección propuesta por el LLM y arma el pin para que la persona lo confirme o mueva.
 * `onMiss` decide qué responder si no se encuentra o el geocodificador falla.
 */
async function geocodedProposal(
  deps: IntakeDeps,
  territoryId: string,
  address: string,
  intake: IntakeConfig,
  t: Render,
  llmRunId: string,
  onMiss: { notFound: () => Promise<Reply>; error: Reply },
): Promise<Reply> {
  let hit = null;
  try {
    hit = await geocode(deps.pool, { query: address, territoryId, policy: intake.geocoder });
  } catch {
    return onMiss.error;
  }
  if (!hit) return { ...(await onMiss.notFound()), llmRunId };
  return {
    body: await t("location_proposed", { label: address }),
    origin: "template",
    ui: { kind: "propose_location", lon: hit.lon, lat: hit.lat, label: address },
    llmRunId,
  };
}

async function proposeAddress(
  deps: IntakeDeps,
  reportId: string,
  revision: number,
  territoryId: string,
  intake: IntakeConfig,
  t: Render,
): Promise<{ reply: Reply; address: string | null }> {
  const fallback: Reply = { body: await t("ask_location"), origin: "template", ui: { kind: "ask_location" } };
  if (!deps.llm) return { reply: fallback, address: null };
  const terr = await deps.pool.query<{ name: string }>("select name from territories where id = $1", [territoryId]);
  const extracted = await extractAddress(llmDeps(deps), {
    reportId, revision, messages: await citizenTexts(deps.pool, reportId), territoryName: terr.rows[0].name, config: intake.llm,
  });
  if (!extracted.ok || !extracted.value.address) return { reply: fallback, address: null };
  const address = extracted.value.address;
  const reply = await geocodedProposal(deps, territoryId, address, intake, t, extracted.llmRunId, {
    notFound: async () => ({ body: await t("location_not_found", { query: address }), origin: "template", ui: { kind: "ask_location" } }),
    error: fallback,
  });
  return { reply, address };
}

/** Repregunta redactada por el LLM; si falla o no hay LLM, la plantilla del campo pedido. */
async function askEvidence(
  deps: IntakeDeps,
  reportId: string,
  revision: number,
  ev: StoredEvaluation,
  requestedField: "photo" | "description",
  intake: IntakeConfig,
  t: Render,
): Promise<Reply> {
  const ui: MessageUi = { kind: "ask_evidence", requestedField };
  const fallback: Reply = { body: await t(requestedField === "photo" ? "ask_better_photo" : "ask_description"), origin: "template", ui };
  if (!deps.llm) return fallback;
  const res = await clarify(llmDeps(deps), {
    reportId, revision, requestedField, reasons: evidenceReasons(ev, requestedField), messages: await citizenTexts(deps.pool, reportId), config: intake.llm,
  });
  if (!res.ok) return { ...fallback, llmRunId: res.llmRunId ?? null };
  return { body: res.value.question, origin: "llm", ui, llmRunId: res.llmRunId };
}

/**
 * Texto nuevo tras la ficha lista: el LLM propone qué cambia. Solo un cambio de ubicación produce una propuesta
 * (pin geocodificado que la persona confirma); la descripción sigue siendo el relato original, ya reevaluado por Jev.
 * Sin LLM, sin cambios o con error ⇒ ficha lista (o el pin pendiente, si hay uno).
 * Dirección corregida que no se encuentra ⇒ aviso + ficha lista: la ubicación ya está confirmada, así que
 * `ask_location` no tendría salida desde el chat y cada mensaje volvería a esta rama.
 */
async function proposeCorrection(
  deps: IntakeDeps,
  r: Awaited<ReturnType<typeof getReport>>,
  revision: number,
  intake: IntakeConfig,
  t: Render,
  ready: () => Promise<Reply>,
): Promise<Reply> {
  const fallback = await ready();
  if (!deps.llm) return fallback;
  const res = await interpretCorrection(llmDeps(deps), {
    reportId: r.id,
    revision,
    draft: { description: r.description, locationText: r.location_text, areaName: await areaName(deps.pool, r.area_id) },
    newMessages: await textsAfterReady(deps.pool, r.conversation_id),
    config: intake.llm,
  });
  if (!res.ok) return { ...fallback, llmRunId: res.llmRunId ?? null };
  const proposed = res.value.proposedFields.locationText;
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!proposed || norm(proposed) === norm(r.location_text)) return { ...fallback, llmRunId: res.llmRunId };
  return geocodedProposal(deps, r.territory_id!, proposed, intake, t, res.llmRunId, {
    notFound: async () => ({ ...fallback, body: `${await t("location_not_found", { query: proposed })}\n\n${fallback.body}` }),
    error: { ...fallback, llmRunId: res.llmRunId },
  });
}

async function readyText(db: Pool, r: Awaited<ReturnType<typeof getReport>>, ev: StoredEvaluation, t: (k: string, v?: Record<string, string>) => Promise<string>) {
  const type = ev.problemTypeId
    ? (await db.query<{ name: string }>("select name from problem_types where id = $1", [ev.problemTypeId])).rows[0]?.name
    : null;
  const area = await areaName(db, r.area_id);
  const place = [r.location_text, area].filter(Boolean).join(", ") || "el punto marcado";
  return t("draft_ready", { type: type ?? "un problema sin clasificar", place });
}

async function statusSummary(db: Pool, sessionId: string, territoryId: string): Promise<string> {
  const { rows } = await db.query<{ public_code: string; processing: string; outcome: string | null; incident_status: string | null }>(
    `select r.public_code, r.processing, r.outcome, i.status as incident_status
     from reports r
     left join report_incident_links l on l.report_id = r.id and l.active
     left join incidents i on i.id = l.incident_id
     where r.citizen_session_id = $1 and r.status = 'confirmed' order by r.confirmed_at desc limit 3`,
    [sessionId],
  );
  if (!rows.length) return renderTemplate(db, territoryId, "greeting_other");
  const lines = await Promise.all(
    rows.map((x) =>
      renderTemplate(db, territoryId, "status_card", {
        code: x.public_code,
        status: statusLabel(x.processing as never, x.outcome as never, x.incident_status as never),
      }),
    ),
  );
  return lines.join("\n");
}

export type { Branch };
