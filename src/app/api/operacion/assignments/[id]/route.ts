import type { NextRequest } from "next/server";
import { requireOperator, requireOperatorSession } from "@/server/access/internal-session";
import { getPool } from "@/server/db/pool";
import { withTx } from "@/server/db/tx";
import { assignmentTerritory, performOperatorAction } from "@/server/dispatch/operator-action";
import { handle } from "@/server/http";
import { TransitionBody } from "@/shared/contracts/assignment";

/** Acción del operador sobre una orden (cancelar o completar). Permisos desde la sesión; la máquina de estados decide. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/operacion/assignments/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    // Autenticación y rol antes que cualquier validación de entrada o búsqueda: la respuesta no revela qué órdenes existen.
    const s = await requireOperatorSession();
    const body = TransitionBody.parse(await req.json());
    const result = await withTx(async (c) => {
      requireOperator(s, await assignmentTerritory(c, id));
      return performOperatorAction(c, { assignmentId: id, userId: s.userId, body });
    }, getPool());
    return Response.json(result);
  });
}
