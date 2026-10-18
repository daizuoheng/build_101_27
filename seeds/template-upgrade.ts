import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import { withTx } from "../src/server/db/tx";
import { appendEvent } from "../src/server/events/append";
import { templates } from "./templates";

export type TemplateUpgradeResult = { updated: string[]; inserted: string[]; unchanged: string[]; unknown: string[] };

/**
 * Opciones del CLI (`--keys a,b | --all`, `--dry-run`), o `null` si no son válidas. Estricto a propósito: el comando
 * escribe por defecto, así que una opción mal escrita (`--dryrun`, `--dry-run=true`, `--dry-run false`) se rechaza
 * en lugar de ignorarse y terminar aplicando.
 */
export function parseTemplateUpgradeArgs(args: Record<string, string>): { keys: string[] | "all"; dryRun: boolean } | null {
  if (Object.keys(args).some((k) => !["keys", "all", "dry-run"].includes(k))) return null;
  if (args["dry-run"] !== undefined && args["dry-run"] !== "true") return null;
  if (args.all !== undefined && args.all !== "true") return null;
  // `--keys` sin valor llega como "true".
  const keys = args.keys === "true" ? [] : (args.keys ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  const all = args.all === "true";
  if (all === keys.length > 0 || (args.keys !== undefined && !keys.length)) return null;
  return { keys: all ? "all" : keys, dryRun: args["dry-run"] === "true" };
}

/**
 * Lleva las plantillas globales (`territory_id is null`) de las claves pedidas al texto del seed: inserta las que
 * faltan y actualiza las que difieren en `body` o `variables`. `seedAll` nunca pisa filas; esto es el paso explícito
 * para cuando el seed cambió un texto. Nunca toca personalizaciones por territorio. Cada actualización deja un evento
 * `template_upgraded` con el texto anterior, para poder volver atrás a mano. Con `dryRun` informa sin escribir.
 */
export async function upgradeTemplates(
  pool: Pool,
  opts: { keys: string[] | "all"; dryRun?: boolean },
): Promise<TemplateUpgradeResult> {
  const requested = opts.keys === "all" ? [...new Set(templates.map((t) => t.key))] : [...new Set(opts.keys)];
  const result: TemplateUpgradeResult = { updated: [], inserted: [], unchanged: [], unknown: [] };

  await withTx(async (c) => {
    // Dos corridas a la vez no deben insertar la misma clave ni registrar dos veces el mismo texto anterior.
    await c.query("select pg_advisory_xact_lock(hashtext('template-upgrade'))");
    for (const key of requested) {
      const entries = templates.filter((t) => t.key === key);
      if (!entries.length) {
        result.unknown.push(key);
        continue;
      }
      for (const t of entries) {
        const { rows } = await c.query<{ id: string; body: string; variables: unknown }>(
          "select id, body, variables from message_templates where territory_id is null and key = $1 and locale = $2 for update",
          [t.key, t.locale],
        );
        const row = rows[0];
        if (!row) {
          result.inserted.push(key);
          if (!opts.dryRun) {
            await c.query(
              "insert into message_templates (territory_id, key, locale, body, variables) values (null, $1, $2, $3, $4)",
              [t.key, t.locale, t.body, JSON.stringify(t.variables)],
            );
          }
        } else if (row.body === t.body && isDeepStrictEqual(row.variables, t.variables)) {
          result.unchanged.push(key);
        } else {
          result.updated.push(key);
          if (!opts.dryRun) {
            await c.query("update message_templates set body = $2, variables = $3, updated_at = now() where id = $1", [
              row.id,
              t.body,
              JSON.stringify(t.variables),
            ]);
            await appendEvent(c, {
              entityType: "message_template",
              entityId: row.id,
              kind: "template_upgraded",
              actorType: "system",
              data: { key: t.key, locale: t.locale, previous_body: row.body, previous_variables: row.variables },
            });
          }
        }
      }
    }
  }, pool);

  return result;
}
