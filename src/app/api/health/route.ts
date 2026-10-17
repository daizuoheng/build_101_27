import { Pool } from "pg";
import { poolConfig } from "@/server/db/pool";

/** Topes del healthcheck: conectar (incluido el handshake TLS) y responder `select 1`. */
const CONNECT_TIMEOUT_MS = 3_000;
const QUERY_TIMEOUT_MS = 2_000;

/**
 * Pool propio de una conexión, con timeouts. El pool de la app no tiene timeout de conexión a propósito (lleno,
 * encola en vez de fallar), así que un healthcheck sobre él podría quedar colgado con la base inalcanzable o un
 * handshake trabado. Acá cada espera (conectar, hacer cola, consultar) tiene tope, y la conexión ociosa se cierra
 * enseguida para no ocupar un lugar del pooler de sesión.
 */
let health: Pool | null = null;
function healthPool(): Pool {
  if (!health) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL no está configurada");
    health = new Pool({
      ...poolConfig(url),
      max: 1,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      idleTimeoutMillis: 1_000,
    });
    health.on("connect", (c) => c.on("error", (e) => console.error("health: conexión perdida:", e.message)));
    health.on("error", () => {}); // ya logueado arriba
  }
  return health;
}

/** Healthcheck del despliegue: el proceso responde y llega a la base. Sin detalles internos. */
export async function GET() {
  try {
    await healthPool().query("select 1");
    return Response.json({ ok: true });
  } catch (e) {
    console.error("health:", e instanceof Error ? e.message : e);
    return Response.json({ ok: false }, { status: 503 });
  }
}
