import { getPool } from "@/server/db/pool";

/** Healthcheck del despliegue: el proceso responde y llega a la base. Sin detalles internos. */
export async function GET() {
  try {
    await getPool().query("select 1");
    return Response.json({ ok: true });
  } catch (e) {
    console.error("health:", e instanceof Error ? e.message : e);
    return Response.json({ ok: false }, { status: 503 });
  }
}
