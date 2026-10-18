import type { NextRequest } from "next/server";
import { requireOperatorSession } from "@/server/access/internal-session";
import { getPool } from "@/server/db/pool";
import { withTx } from "@/server/db/tx";
import { handle } from "@/server/http";
import { operatorIncidentTerritory, requestLink } from "@/server/incidents/operator-requests";
import { LinkBody } from "@/shared/contracts/incident";

/** Asociar un reporte a este incidente o desasociar uno de sus reportes (vínculo manual, idempotente por clave). */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/operacion/incidents/[id]/links">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const s = await requireOperatorSession();
    const body = LinkBody.parse(await req.json());
    const result = await withTx(async (c) => {
      await operatorIncidentTerritory(c, s, id);
      return requestLink(c, { incidentId: id, userId: s.userId, body });
    }, getPool());
    return Response.json(result);
  });
}
