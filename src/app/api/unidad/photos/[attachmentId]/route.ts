import type { NextRequest } from "next/server";
import { requireUnit } from "@/server/access/internal-session";
import { getDeps } from "@/server/deps";
import { handle } from "@/server/http";
import { getUnitPhoto } from "@/server/unit/photos";

/** Foto de evidencia de una orden activa de la unidad autenticada (JPEG normalizado). */
export async function GET(_req: NextRequest, ctx: RouteContext<"/api/unidad/photos/[attachmentId]">) {
  return handle(async () => {
    const { attachmentId } = await ctx.params;
    const session = await requireUnit();
    const deps = getDeps();
    const bytes = await getUnitPhoto(deps.pool, deps.storage, { unitId: session.responseUnitId, attachmentId });
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" },
    });
  });
}
