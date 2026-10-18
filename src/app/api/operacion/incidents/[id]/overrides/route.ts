import type { NextRequest } from "next/server";
import { requireOperatorSession } from "@/server/access/internal-session";
import { getPool } from "@/server/db/pool";
import { withTx } from "@/server/db/tx";
import { handle } from "@/server/http";
import { operatorIncidentTerritory, requestSetOverride } from "@/server/incidents/operator-requests";
import { SetOverrideBody } from "@/shared/contracts/incident";

/** Corrección del operador sobre un campo del incidente (idempotente por clave; revisión vieja ⇒ 409). */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/operacion/incidents/[id]/overrides">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const s = await requireOperatorSession();
    const body = SetOverrideBody.parse(await req.json());
    const result = await withTx(async (c) => {
      await operatorIncidentTerritory(c, s, id);
      return requestSetOverride(c, { incidentId: id, userId: s.userId, body });
    }, getPool());
    return Response.json(result);
  });
}
