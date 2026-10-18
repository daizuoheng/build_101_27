import type { NextRequest } from "next/server";
import { requireOperatorSession } from "@/server/access/internal-session";
import { getPool } from "@/server/db/pool";
import { withTx } from "@/server/db/tx";
import { handle } from "@/server/http";
import { operatorIncidentTerritory, requestRemoveOverride } from "@/server/incidents/operator-requests";
import { RemoveOverrideBody } from "@/shared/contracts/incident-detail";

/** Quita la corrección vigente de un campo (idempotente por clave, que viaja en el cuerpo). */
export async function DELETE(req: NextRequest, ctx: RouteContext<"/api/operacion/incidents/[id]/overrides/[field]">) {
  return handle(async () => {
    const { id, field } = await ctx.params;
    const s = await requireOperatorSession();
    const { idempotencyKey } = RemoveOverrideBody.parse(await req.json());
    const result = await withTx(async (c) => {
      await operatorIncidentTerritory(c, s, id);
      return requestRemoveOverride(c, { incidentId: id, userId: s.userId, field, idempotencyKey });
    }, getPool());
    return Response.json(result);
  });
}
