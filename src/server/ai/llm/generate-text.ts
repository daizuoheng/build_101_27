import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getActivePolicy, type TextgenPolicy } from "../../config/policies";
import { renderTemplate } from "../../config/templates";
import type { Db } from "../../db/pool";
import { withTx } from "../../db/tx";
import { recordLlmRun, type LlmRunRecord } from "../runs";
import { callJson, type LlmClient } from "./client";

export type TextPurpose = "title" | "summary" | "explain_priority";

/** Hecho del backend, ya legible. Las listas se unen con el separador de la política para las plantillas. */
export type TextFact = string | number | string[];
export type TextReference = { id: string; text: string };

export type TextInput = {
  purpose: TextPurpose;
  territoryId: string;
  entity: { type: string; id: string; revision: number };
  facts: Record<string, TextFact>;
  /** Lo único que el texto puede citar: descripciones de reportes, códigos de motivo, etc. */
  references: TextReference[];
};

export type DraftedText = { body: string; references: string[]; llmRunId: string | null; source: "llm" | "template"; error?: string };
export type GeneratedText = Omit<DraftedText, "source"> & { source: "cache" | "llm" | "template"; discarded: boolean };

export type TextDeps = { pool: Pool; llm: LlmClient | null };

const RUN_PURPOSE: Record<TextPurpose, LlmRunRecord["purpose"]> = { title: "title", summary: "summary", explain_priority: "explain" };

const Output = z.object({ body: z.string().trim().min(1), references: z.array(z.string()) });

/** Largo máximo y frases prohibidas (despacho, tiempos): valen igual para el LLM y para la plantilla. */
function bodyViolation(policy: TextgenPolicy, purpose: TextPurpose, body: string): string | null {
  const max = policy.max_chars[purpose];
  if (body.length > max) return `texto de ${body.length} caracteres (máximo ${max})`;
  const hit = policy.forbidden_patterns.find((p) => new RegExp(p, "iu").test(body));
  return hit ? `texto con contenido prohibido por política (${hit})` : null;
}

/**
 * Plantilla de respaldo `textgen_<propósito>` con los hechos como variables. Una plantilla que viola la política
 * es un error de configuración: falla en lugar de mostrarse y cachearse.
 */
async function fromTemplate(db: Db, policy: TextgenPolicy, input: TextInput, error: string): Promise<DraftedText> {
  const sep = policy.labels.list_separator;
  const vars = Object.fromEntries(Object.entries(input.facts).map(([k, v]) => [k, Array.isArray(v) ? v.join(sep) : v]));
  const key = `textgen_${input.purpose}`;
  const body = await renderTemplate(db, input.territoryId, key, vars);
  const bad = bodyViolation(policy, input.purpose, body);
  if (bad) throw new Error(`plantilla '${key}' inválida: ${bad}`);
  return { body, references: [], llmRunId: null, source: "template", error };
}

/** Rechazos semánticos del LLM: los de la plantilla más referencias ajenas al input. */
export function checkText(policy: TextgenPolicy, input: TextInput, out: { body: string; references: string[] }): string | null {
  const allowed = new Set(input.references.map((r) => r.id));
  const foreign = out.references.filter((id) => !allowed.has(id));
  if (foreign.length) return `referencias fuera del input: ${foreign.join(", ")}`;
  return bodyViolation(policy, input.purpose, out.body);
}

/**
 * Mensaje al LLM: hechos del backend como json y, aparte y delimitadas, las referencias. Su texto lo escribió un
 * ciudadano: se recorta por política y se escapa `<` para que no pueda cerrar el delimitador.
 */
export function userMessage(policy: TextgenPolicy, input: TextInput): string {
  const refs = input.references.map((r) => ({ id: r.id, text: r.text.slice(0, policy.max_reference_chars) }));
  const quoted = JSON.stringify(refs).replace(/</g, "\\u003c");
  return `${JSON.stringify({ purpose: input.purpose, facts: input.facts })}\n<referencias>\n${quoted}\n</referencias>`;
}

/**
 * Redacta un texto sin cachear: LLM con `callJson` (json_object, Zod, un reintento, `llm_runs`) y validación
 * contra el input; si está apagado por política, no hay cliente o la salida no valida, plantilla.
 */
export async function draftText(deps: { db: Db; llm: LlmClient | null }, policy: TextgenPolicy, input: TextInput): Promise<DraftedText> {
  if (!policy.enabled) return fromTemplate(deps.db, policy, input, "textgen deshabilitado por política");
  if (!deps.llm) return fromTemplate(deps.db, policy, input, "sin cliente LLM configurado");
  const fill = (s: string) => s.replace(/\{\{max_chars\}\}/g, String(policy.max_chars[input.purpose]));
  const system = [policy.instructions.common, policy.instructions.untrusted, fill(policy.instructions[input.purpose]), policy.instructions.output].join("\n");
  const user = userMessage(policy, input);
  const res = await callJson(
    { llm: deps.llm, recordRun: (r) => recordLlmRun(deps.db, r) },
    {
      purpose: RUN_PURPOSE[input.purpose],
      config: policy,
      system,
      user,
      schema: Output,
      entityRef: { entity_type: input.entity.type, entity_id: input.entity.id, entity_revision: input.entity.revision, text_purpose: input.purpose },
      validate: (v) => checkText(policy, input, v),
    },
  );
  if (!res.ok) return fromTemplate(deps.db, policy, input, res.error);
  return { body: res.value.body, references: [...new Set(res.value.references)], llmRunId: res.llmRunId, source: "llm" };
}

type CachedRow = { body: string; references: string[]; llm_run_id: string | null };

async function cached(db: Db, input: TextInput): Promise<CachedRow | null> {
  const { rows } = await db.query<CachedRow>(
    `select body, "references", llm_run_id from generated_texts
     where purpose = $1 and entity_type = $2 and entity_id = $3 and entity_revision = $4`,
    [input.purpose, input.entity.type, input.entity.id, input.entity.revision],
  );
  return rows[0] ?? null;
}

/**
 * Texto cacheado en `generated_texts` por (propósito, entidad, revisión). Un texto del LLM es definitivo para su
 * revisión; uno de plantilla se reintenta con el LLM en la próxima llamada si la política lo permite.
 * Sin política `textgen` válida falla: es un error de configuración, no del LLM.
 * La IA corre fuera de la transacción; `isCurrent` se evalúa al persistir y, si da falso, el texto se descarta.
 */
export async function generateText(deps: TextDeps, input: TextInput, opts: { isCurrent?: (c: PoolClient) => Promise<boolean> } = {}): Promise<GeneratedText> {
  const policy = (await getActivePolicy(deps.pool, input.territoryId, "textgen")).config;
  const hit = await cached(deps.pool, input);
  if (hit && (hit.llm_run_id || !policy.enabled)) {
    return { body: hit.body, references: hit.references, llmRunId: hit.llm_run_id, source: "cache", discarded: false };
  }

  const drafted = await draftText({ db: deps.pool, llm: deps.llm }, policy, input);

  const persisted = await withTx(async (c) => {
    if (opts.isCurrent && !(await opts.isCurrent(c))) return false;
    await c.query(
      `insert into generated_texts (purpose, entity_type, entity_id, entity_revision, body, "references", llm_run_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (purpose, entity_type, entity_id, entity_revision) do update
         set body = excluded.body, "references" = excluded."references", llm_run_id = excluded.llm_run_id
         where generated_texts.llm_run_id is null and excluded.llm_run_id is not null`,
      [input.purpose, input.entity.type, input.entity.id, input.entity.revision, drafted.body, JSON.stringify(drafted.references), drafted.llmRunId],
    );
    return true;
  }, deps.pool);

  return { ...drafted, discarded: !persisted };
}
