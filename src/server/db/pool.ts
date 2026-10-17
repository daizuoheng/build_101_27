import { Pool, types, type PoolClient, type PoolConfig } from "pg";

// int8 (count, sum) como number: los conteos del dominio caben en 2^53.
types.setTypeParser(20, (v) => Number(v));

export type Db = Pool | PoolClient;

let pool: Pool | null = null;

/** Puerto del pooler transaccional de Supabase: no sirve (advisory lock del migrador y jobs necesitan sesión). */
const TRANSACTION_POOLER_PORT = "6543";

/** Hosts de loopback sin TLS. WHATWG URL deja IPv6 entre corchetes; "" es el host por defecto (`postgres:///db`). */
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "[::1]", "::1"]);

/** Archivos de certificado en la URL: `pg` los leería del disco; acá el certificado entra por `DATABASE_CA_CERT`. */
const SSL_FILE_PARAMS = ["sslcert", "sslkey", "sslrootcert"];

/** Modos que piden verificar el certificado: sin CA no se pueden cumplir y no se degradan en silencio. */
const VERIFY_MODES = new Set(["verify-ca", "verify-full"]);

/**
 * Los de libpq que `pg` puede cumplir, más `no-verify` (propio de `pg`). `prefer`/`allow` caen a texto plano si el
 * servidor no tiene TLS; `pg` no sabe hacerlo y no se finge.
 */
const SSL_MODES = new Set(["disable", "no-verify", "require", ...VERIFY_MODES]);

/**
 * Host efectivo como lo resuelve `pg-connection-string`: un `?host=` no vacío pisa al de la URL; `/…` es un socket
 * Unix (en el hostname viene como `%2F…`).
 */
function isLocal(url: URL): boolean {
  const host = (url.searchParams.get("host") || url.hostname.replace(/^%2f/i, "/")).toLowerCase();
  return LOCAL_HOSTS.has(host) || host.startsWith("/");
}

/** `sslmode` de la URL, o su equivalente si viene el `?ssl=` booleano que también acepta `pg`. */
function sslMode(url: URL): string | undefined {
  const raw = url.searchParams.get("sslmode") ?? undefined;
  const flag = url.searchParams.get("ssl")?.toLowerCase();
  const mode = raw?.toLowerCase() ?? (flag === "0" || flag === "false" ? "disable" : flag === "1" || flag === "true" ? "require" : flag);
  if (mode !== undefined && !SSL_MODES.has(mode)) {
    const param = raw !== undefined ? `sslmode=${raw}` : `ssl=${flag}`;
    throw new Error(`DATABASE_URL trae ${param}: no se admite; usá sslmode=disable, require, verify-ca o verify-full`);
  }
  return mode;
}

/**
 * TLS según la URL y `DATABASE_CA_CERT`. `pg` aplica los `ssl*` de la URL por encima de `ssl`, así que
 * `poolConfig` los saca de la URL y esta función decide sola. Sin `sslmode`: local sin TLS, remoto con TLS.
 * Un `sslmode` explícito manda también en local (túnel o proxy hacia la base remota).
 */
function resolveSsl(url: URL, ca: string | undefined): PoolConfig["ssl"] {
  const mode = sslMode(url);
  if (mode === "disable") return false;
  if (mode && VERIFY_MODES.has(mode) && !ca) throw new Error(`DATABASE_URL pide sslmode=${mode} pero falta DATABASE_CA_CERT`);
  if (!mode && isLocal(url)) return undefined;
  if (mode === "no-verify" || !ca) return { rejectUnauthorized: false }; // cifra sin verificar (`require` de libpq)
  // verify-ca, y require con CA, como libpq: la cadena sí, el nombre no (túnel por localhost o conexión por IP).
  if (mode === "verify-ca" || mode === "require") return { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined };
  return { ca, rejectUnauthorized: true }; // verify-full, o sin sslmode en un host remoto: cadena y nombre
}

/**
 * Configuración de conexión. Fuera de localhost siempre TLS (ver `resolveSsl`); `sslmode=disable` lo apaga
 * (Postgres de CI o red privada sin TLS). `sslmode` no llega a `pg` porque `pg` 8 trata `require` como `verify-full`
 * y fallaría sin CA; `sslcert`/`sslkey`/`sslrootcert` se rechazan para no perder la verificación en silencio.
 */
export function poolConfig(connectionString: string, env: Record<string, string | undefined> = process.env): PoolConfig {
  const url = new URL(connectionString);
  // Como `host`, `?port=` pisa al puerto de la URL en `pg-connection-string`.
  if ((url.searchParams.get("port") ?? url.port) === TRANSACTION_POOLER_PORT) {
    throw new Error("DATABASE_URL apunta al pooler transaccional (puerto 6543): usá el modo sesión (puerto 5432)");
  }
  const fileParam = SSL_FILE_PARAMS.find((k) => url.searchParams.has(k));
  if (fileParam) throw new Error(`DATABASE_URL trae ${fileParam}: no se admite; pasá el certificado raíz en DATABASE_CA_CERT`);

  const max = env.DATABASE_POOL_MAX ? Number(env.DATABASE_POOL_MAX) : 10;
  if (!Number.isInteger(max) || max < 1) throw new Error(`DATABASE_POOL_MAX inválido: "${env.DATABASE_POOL_MAX}" (entero ≥ 1)`);

  const ssl = resolveSsl(url, env.DATABASE_CA_CERT?.replace(/\\n/g, "\n") || undefined);
  for (const k of [...url.searchParams.keys()]) if (k.startsWith("ssl")) url.searchParams.delete(k);
  // keepAlive: detecta conexiones medio abiertas (NAT o Supavisor que las tira sin avisar) en vez de esperar al
  // timeout de retransmisión del sistema.
  return { connectionString: url.toString(), max, ssl, keepAlive: true };
}

export function createPool(connectionString: string): Pool {
  const p = new Pool(poolConfig(connectionString));
  // Si el servidor corta una conexión (reinicio de Supavisor, mantenimiento, red), el cliente emite `error`.
  // pg-pool solo lo escucha mientras el cliente está ocioso; uno tomado con `connect()` (withTx, migrador) no tiene
  // listener y la excepción no capturada tiraría el proceso. La consulta en curso igual falla con ese error.
  p.on("connect", (client) => client.on("error", (e) => console.error("pg: conexión perdida:", e.message)));
  // Con el cliente ocioso pg-pool lo reemite en el pool (y lo descarta): ya quedó logueado arriba.
  p.on("error", () => {});
  return p;
}

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL no está configurada");
    pool = createPool(url);
  }
  return pool;
}
