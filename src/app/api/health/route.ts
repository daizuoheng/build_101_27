import { getPool } from "@/server/db/pool";

/**
 * Tope de la consulta. El pool no tiene timeout de conexión a propósito (un pool lleno encola en vez de fallar),
 * así que sin esto una base inalcanzable dejaría el healthcheck colgado en lugar de responder 503.
 */
const HEALTH_TIMEOUT_MS = 5_000;

/** Healthcheck del despliegue: el proceso responde y llega a la base. Sin detalles internos. */
export async function GET() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin respuesta de la base en ${HEALTH_TIMEOUT_MS} ms`)), HEALTH_TIMEOUT_MS);
  });
  try {
    await Promise.race([getPool().query("select 1"), timeout]);
    return Response.json({ ok: true });
  } catch (e) {
    console.error("health:", e instanceof Error ? e.message : e);
    return Response.json({ ok: false }, { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}
