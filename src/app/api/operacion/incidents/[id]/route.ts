import type { NextRequest } from "next/server";
import { requireOperatorSession } from "@/server/access/internal-session";
import { getPool } from "@/server/db/pool";
import { handle } from "@/server/http";
import { getIncidentDetail } from "@/server/incidents/detail";
import { operatorIncidentTerritory } from "@/server/incidents/operator-requests";

/** Detalle del incidente para el operador de su territorio (`IncidentDetailResponse`). Ajeno o inexistente ⇒ 404. */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/operacion/incidents/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    // Sesión antes que cualquier búsqueda: la respuesta no revela qué incidentes existen.
    const s = await requireOperatorSession();
    const pool = getPool();
    await operatorIncidentTerritory(pool, s, id);
    const { body } = await getIncidentDetail(pool, id);
    return Response.json(body);
  });
}
