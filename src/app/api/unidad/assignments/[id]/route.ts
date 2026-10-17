import type { NextRequest } from "next/server";
import { getPool } from "@/server/db/pool";
import { withTx } from "@/server/db/tx";
import { requireUnit } from "@/server/access/internal-session";
import { handle } from "@/server/http";
import { dispatchUnavailable, performUnitAction } from "@/server/unit/actions";
import { transitionAssignment } from "@/server/unit/dispatch-port";
import { getUnitInbox } from "@/server/unit/inbox";
import { TransitionBody } from "@/shared/contracts/assignment";

/**
 * Acción de la unidad (accept | reject | start | complete) sobre una orden suya.
 * 409 si `expectedVersion` no coincide: la UI refresca la bandeja. Devuelve la bandeja actualizada.
 */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/unidad/assignments/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = TransitionBody.parse(await req.json());
    const session = await requireUnit();
    if (!transitionAssignment) throw dispatchUnavailable();
    const deps = { transitionAssignment };
    const pool = getPool();
    const result = await withTx(
      (c) => performUnitAction(c, deps, { assignmentId: id, unitId: session.responseUnitId, userId: session.userId, body }),
      pool,
    );
    return Response.json({ result, inbox: await getUnitInbox(pool, session.responseUnitId) });
  });
}
