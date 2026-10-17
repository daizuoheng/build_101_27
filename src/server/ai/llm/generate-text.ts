import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getActivePolicy, type TextgenPolicy } from "../../config/policies";
import { renderTemplate } from "../../config/templates";
import type { Db } from "../../db/pool";
import { withTx } from "../../db/tx";
import { recordLlmRun, type LlmRunRecord } from "../runs";
import { callJson, type LlmClient, type LlmDeps } from "./client";

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
  const length = Array.from(body).length; // por punto de código, igual que el recorte de la plantilla
  if (length > max) return `texto de ${length} caracteres (máximo ${max})`;
  const hit = policy.forbidden_patterns.find((p) => p.test(body));
  return hit ? `texto con contenido prohibido por política (${hit.source})` : null;
}

/**
 * Hechos listos para cualquiera de los dos caminos: un dato (a menudo texto ciudadano, como el lugar) con una frase
 * prohibida se reemplaza por `labels.redacted`. Así el LLM no la copia y la plantilla no la muestra.
 */
export function redactFacts(policy: TextgenPolicy, facts: TextInput["facts"]): TextInput["facts"] {
  return Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, typeof v === "string" ? scrub(policy, v) : Array.isArray(v) ? v.map((x) => scrub(policy, x)) : v]));
}

/** Tapa solo la frase prohibida: un falso positivo no borra la dirección entera. */
function scrub(policy: TextgenPolicy, text: string): string {
  return policy.forbidden_patterns.reduce((acc, p) => acc.replace(new RegExp(p.source, "giu"), policy.labels.redacted), text);
}

/**
 * Plantilla de respaldo `textgen_<propósito>` con los hechos como variables. El texto fijo de la plantilla (sin
 * variables) que viola la política es un error de configuración y falla. Los datos llegan ya redactados; si aun así
 * el texto completo arma una frase prohibida (plantilla + dato), se omiten todos los datos de texto. El resultado se
 * recorta al máximo en vez de fallar en cada reintento.
 */
async function fromTemplate(db: Db, policy: TextgenPolicy, input: TextInput, error: string | undefined): Promise<DraftedText> {
  const key = `textgen_${input.purpose}`;
  const bad = bodyViolation(policy, input.purpose, await renderTemplate(db, input.territoryId, key));
  if (bad) throw new Error(`plantilla '${key}' inválida: ${bad}`);
  const sep = policy.labels.list_separator;
  const max = policy.max_chars[input.purpose];
  const render = async (facts: TextInput["facts"]) => {
    const vars = Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, Array.isArray(v) ? v.join(sep) : v]));
    const chars = Array.from(await renderTemplate(db, input.territoryId, key, vars)); // por punto de código: no parte emojis
    return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
  };
  let body = await render(redactFacts(policy, input.facts));
  if (bodyViolation(policy, input.purpose, body)) {
    body = await render(Object.fromEntries(Object.entries(input.facts).map(([k, v]) => [k, typeof v === "number" ? v : policy.labels.redacted])));
    const still = bodyViolation(policy, input.purpose, body);
    if (still) throw new Error(`plantilla '${key}' inválida con datos numéricos: ${still}`);
  }
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
 * Mensaje al LLM: hechos y referencias como json, cada uno en su bloque delimitado. Los dos pueden traer texto
 * ciudadano (el lugar escrito, las descripciones): se recorta por política y se escapa `<` para que no pueda
 * cerrar el delimitador. La instrucción `untrusted` de la política dice que ahí solo hay datos.
 */
export function userMessage(policy: TextgenPolicy, input: TextInput): string {
  const cap = (t: string) => Array.from(t).slice(0, policy.max_reference_chars).join(""); // por punto de código
  const redacted = redactFacts(policy, input.facts);
  const facts = Object.fromEntries(Object.entries(redacted).map(([k, v]) => [k, typeof v === "string" ? cap(v) : Array.isArray(v) ? v.map(cap) : v]));
  // En las descripciones solo se tapa la frase prohibida: el resto es la evidencia que el resumen necesita.
  const refs = input.references.map((r) => ({ id: r.id, text: cap(scrub(policy, r.text)) }));
  const block = (tag: string, v: unknown) => `<${tag}>\n${JSON.stringify(v).replace(/</g, "\\u003c")}\n</${tag}>`;
  return [block("hechos", { purpose: input.purpose, facts }), block("referencias", refs)].join("\n");
}

/** El propósito se redacta con el LLM solo si la política lo lista (y textgen está prendido). */
export function usesLlm(policy: TextgenPolicy, purpose: TextPurpose): boolean {
  return policy.enabled && policy.llm_purposes.includes(purpose);
}

/**
 * Redacta un texto sin cachear: LLM con `callJson` (json_object, Zod, un reintento, `llm_runs`) y validación
 * contra el input. Si la política no lista el propósito en `llm_purposes` (el caso por defecto), sale directo de su
 * plantilla determinista; si no hay cliente o la salida no valida, también.
 */
export async function draftText(
  deps: { db: Db; llm: LlmClient | null; recordRun?: LlmDeps["recordRun"] },
  policy: TextgenPolicy,
  input: TextInput,
): Promise<DraftedText> {
  // Un propósito fuera de llm_purposes es determinista por diseño (sin motivo de fallo); textgen apagado sí se informa.
  if (!policy.enabled) return fromTemplate(deps.db, policy, input, "textgen deshabilitado por política");
  if (!usesLlm(policy, input.purpose)) return fromTemplate(deps.db, policy, input, undefined);
  if (!deps.llm) return fromTemplate(deps.db, policy, input, "sin cliente LLM configurado");
  const fill = (s: string) => s.replace(/\{\{max_chars\}\}/g, String(policy.max_chars[input.purpose]));
  const system = [policy.instructions.common, policy.instructions.untrusted, fill(policy.instructions[input.purpose]), policy.instructions.output].join("\n");
  const user = userMessage(policy, input);
  const res = await callJson(
    { llm: deps.llm, recordRun: deps.recordRun ?? ((r) => recordLlmRun(deps.db, r)) },
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
 * Sin política `textgen` válida falla: es un error de configuración, no del LLM. `opts.policy` evita releerla
 * cuando el llamador ya la tiene (un job usa una sola versión para los tres textos).
 * La IA corre fuera de la transacción; `isCurrent` se evalúa al persistir y, si da falso, el texto se descarta.
 */
export async function generateText(
  deps: TextDeps,
  input: TextInput,
  opts: { isCurrent?: (c: PoolClient) => Promise<boolean>; policy?: TextgenPolicy } = {},
): Promise<GeneratedText> {
  const policy = opts.policy ?? (await getActivePolicy(deps.pool, input.territoryId, "textgen")).config;
  const hit = await cached(deps.pool, input);
  // Una plantilla cacheada solo se reintenta si hay con qué: política prendida y cliente LLM. Un texto cacheado que
  // la política vigente ya no admite (se endurecieron patrones o límites) se vuelve a redactar y se reemplaza.
  const llm = usesLlm(policy, input.purpose);
  // Si el propósito dejó de usar el LLM (textgen apagado o fuera de llm_purposes), sus textos del LLM ya guardados
  // se reemplazan por la plantilla la próxima vez que se pidan (no hay barrido de revisiones ya procesadas).
  const stale = hit !== null && (bodyViolation(policy, input.purpose, hit.body) !== null || (!llm && hit.llm_run_id !== null));
  if (hit && !stale && (hit.llm_run_id || !llm || !deps.llm)) {
    return { body: hit.body, references: hit.references, llmRunId: hit.llm_run_id, source: "cache", discarded: false };
  }

  const drafted = await draftText({ db: deps.pool, llm: deps.llm }, policy, input);

  const persisted = await withTx(async (c) => {
    if (opts.isCurrent && !(await opts.isCurrent(c))) return "discarded" as const;
    const saved = await c.query(
      `insert into generated_texts (purpose, entity_type, entity_id, entity_revision, body, "references", llm_run_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (purpose, entity_type, entity_id, entity_revision) do update
         set body = excluded.body, "references" = excluded."references", llm_run_id = excluded.llm_run_id
         where (generated_texts.llm_run_id is null and excluded.llm_run_id is not null)
            or ($8 and generated_texts.body = $9)
       returning id`,
      // Reemplazo por política vigente solo si la fila sigue siendo la vieja que se leyó (no pisa a otro worker).
      [input.purpose, input.entity.type, input.entity.id, input.entity.revision, drafted.body, JSON.stringify(drafted.references), drafted.llmRunId, stale, hit?.body ?? null],
    );
    // Sin fila: ya había un texto que no se pisa (otro worker con la misma revisión, o un LLM previo). Gana el guardado.
    return saved.rowCount ? ("saved" as const) : await cached(c, input);
  }, deps.pool);

  if (persisted === "discarded") return { ...drafted, discarded: true };
  if (persisted !== "saved" && persisted) {
    // Si este intento cayó a plantilla, se conserva el motivo para el log aunque se devuelva lo guardado.
    return { body: persisted.body, references: persisted.references, llmRunId: persisted.llm_run_id, source: "cache", discarded: false, error: drafted.error };
  }
  return { ...drafted, discarded: false };
}
