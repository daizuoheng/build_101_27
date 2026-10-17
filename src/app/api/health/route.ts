import type { QueryConfig } from "pg";
import { getPool } from "@/server/db/pool";

/**
 * Tope de la respuesta. El pool no tiene timeout de conexión a propósito (un pool lleno encola en vez de fallar),
 * así que sin esto una base inalcanzable dejaría el healthcheck colgado en lugar de responder 503.
 */
const HEALTH_TIMEOUT_MS = 5_000;

/**
 * Consulta en curso, compartida: el timeout abandona la espera pero no cancela la consulta, así que mientras
 * siga pendiente los healthchecks siguientes esperan esa misma en vez de encolar otra en el pool.
 */
let inflight: Promise<unknown> | null = null;

/**
 * `query_timeout` corta la espera una vez tomada la conexión (p. ej. una medio abierta), así la compartida no queda
 * colgada para siempre; el tope de `GET` cubre además la espera por conectar. `pg` lo acepta por consulta
 * (lib/client.js) aunque `@types/pg` no lo declare en `QueryConfig`.
 */
const PING: QueryConfig & { query_timeout: number } = { text: "select 1", query_timeout: HEALTH_TIMEOUT_MS };

/** Healthcheck del despliegue: el proceso responde y llega a la base. Sin detalles internos. */
export async function GET() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin respuesta de la base en ${HEALTH_TIMEOUT_MS} ms`)), HEALTH_TIMEOUT_MS);
  });
  try {
    inflight ??= getPool()
      .query(PING)
      .finally(() => {
        inflight = null;
      });
    await Promise.race([inflight, timeout]);
    return Response.json({ ok: true });
  } catch (e) {
    console.error("health:", e instanceof Error ? e.message : e);
    return Response.json({ ok: false }, { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}
