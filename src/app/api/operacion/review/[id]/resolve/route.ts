import type { NextRequest } from "next/server";
import { requireOperator, requireOperatorSession } from "@/server/access/internal-session";
import { getPool } from "@/server/db/pool";
import { withTx } from "@/server/db/tx";
import { notFound } from "@/server/errors";
import { handle } from "@/server/http";
import { resolveReviewItemIdempotent, reviewItemTerritory } from "@/server/review/resolve";
import { ResolveBody } from "@/shared/contracts/review";

/** Resuelve un ítem de la cola. Permisos desde la sesión; la acción la valida y aplica el dominio. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/operacion/review/[id]/resolve">) {
  return handle(async () => {
    const { id } = await ctx.params;
    // Autenticación y rol antes que cualquier validación de entrada o búsqueda: la respuesta no revela qué ítems existen.
    const s = await requireOperatorSession();
    const body = ResolveBody.parse(await req.json());
    const result = await withTx(async (c) => {
      // Un ítem de otro territorio responde como inexistente (404), no 403: no se revela que existe.
      const territoryId = await reviewItemTerritory(c, id);
      if (territoryId !== s.territoryId) throw notFound("Ítem de revisión inexistente.");
      requireOperator(s, territoryId);
      return resolveReviewItemIdempotent(c, { reviewItemId: id, actor: { type: "operator", id: s.userId }, body });
    }, getPool());
    return Response.json(result);
  });
}
