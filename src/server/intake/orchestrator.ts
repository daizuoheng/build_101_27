import type { Pool } from "pg";
import { withTx } from "../db/tx";
import { getActiveCatalog } from "../config/catalog";
import { getActivePolicy } from "../config/policies";
import { renderTemplate } from "../config/templates";
import type { JevClient } from "../ai/jev/client";
import { evaluateReport } from "../ai/jev/evaluate-report";
import type { LlmClient } from "../ai/llm/client";
import { extractAddress } from "../ai/llm/extract-address";
import { recordAiRun, recordLlmRun } from "../ai/runs";
import { geocode } from "../geo/geocoder";
import { enqueue } from "../jobs/queue";
import type { StorageAdapter } from "../storage/adapter";
import { appendAssistantMessage, areaName, getReport, loadEvidence } from "./drafts";
import { chooseBranch, indicatesActiveHazard, type Branch } from "./branches";
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
  const r = await getReport(deps.pool, reportId);
  if (r.status !== "draft") return;
  const intake = await getActivePolicy(deps.pool, r.territory_id!, "intake");
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

/** Responde a la persona según la rama. Las llamadas de red (LLM, geocodificador) se hacen fuera de la transacción. */
export async function respondToEvaluation(deps: IntakeDeps, reportId: string, revision: number, ev: StoredEvaluation): Promise<void> {
  const r = await getReport(deps.pool, reportId);
  if (r.status !== "draft" || r.revision !== revision) return;
  const territoryId = r.territory_id!;
  const intake = await getActivePolicy(deps.pool, territoryId, "intake");
  const branch = chooseBranch(ev, { locationConfirmed: r.location_confirmed }, intake.config, r.clarification_rounds);
  const t = (key: string, vars?: Record<string, string>) => renderTemplate(deps.pool, territoryId, key, vars);

  let reply: Reply;
  switch (branch.kind) {
    case "orient":
      reply = { body: await t("greeting_other"), origin: "template", ui: null };
      break;
    case "status":
      reply = { body: await statusSummary(deps.pool, r.citizen_session_id, territoryId), origin: "template", ui: { kind: "status" } };
      break;
    case "ask_location":
      reply = { body: await t("ask_location"), origin: "template", ui: { kind: "ask_location" } };
      break;
    case "extract_address":
      reply = await proposeAddress(deps, r.id, revision, territoryId, intake.config, t);
      break;
    case "ask_evidence":
      reply = {
        body: await t(branch.requestedField === "photo" ? "ask_better_photo" : "ask_description"),
        origin: "template",
        ui: { kind: "ask_evidence", requestedField: branch.requestedField },
      };
      break;
    case "ready":
      reply = { body: await readyText(deps.pool, r, ev, t), origin: "template", ui: { kind: "ready" } };
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
    await appendAssistantMessage(c, { conversationId: row.conversation_id, ...reply });
    await c.query(
      `update conversations set replied_revision = $2, clarification_rounds = clarification_rounds + $3, updated_at = now() where id = $1`,
      [row.conversation_id, revision, branch.kind === "ask_evidence" ? 1 : 0],
    );
  }, deps.pool);
}

async function proposeAddress(
  deps: IntakeDeps,
  reportId: string,
  revision: number,
  territoryId: string,
  intake: Awaited<ReturnType<typeof getActivePolicy<"intake">>>["config"],
  t: (key: string, vars?: Record<string, string>) => Promise<string>,
): Promise<Reply> {
  const fallback: Reply = { body: await t("ask_location"), origin: "template", ui: { kind: "ask_location" } };
  if (!deps.llm) return fallback;
  const evidence = await deps.pool.query<{ id: string; body: string }>(
    `select m.id, m.body from messages m join conversations c on c.id = m.conversation_id
     where c.report_id = $1 and m.role = 'citizen' and m.body <> '[foto]' order by m.seq`,
    [reportId],
  );
  const terr = await deps.pool.query<{ name: string }>("select name from territories where id = $1", [territoryId]);
  const extracted = await extractAddress(
    { llm: deps.llm, recordRun: (run) => recordLlmRun(deps.pool, run) },
    { reportId, revision, messages: evidence.rows, territoryName: terr.rows[0].name, config: intake.llm },
  );
  if (!extracted.ok || !extracted.value.address) return fallback;
  let hit = null;
  try {
    hit = await geocode(deps.pool, { query: extracted.value.address, territoryId, policy: intake.geocoder });
  } catch {
    return fallback;
  }
  if (!hit) {
    return { body: await t("location_not_found", { query: extracted.value.address }), origin: "template", ui: { kind: "ask_location" }, llmRunId: extracted.llmRunId };
  }
  return {
    body: await t("location_proposed", { label: extracted.value.address }),
    origin: "template",
    ui: { kind: "propose_location", lon: hit.lon, lat: hit.lat, label: extracted.value.address },
    llmRunId: extracted.llmRunId,
  };
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
