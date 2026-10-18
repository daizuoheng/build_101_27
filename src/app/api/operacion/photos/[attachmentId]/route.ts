import type { NextRequest } from "next/server";
import { requireOperatorSession } from "@/server/access/internal-session";
import { getDeps } from "@/server/deps";
import { handle } from "@/server/http";
import { getOperatorPhoto } from "@/server/incidents/operator-photo";
import { photoSize } from "@/server/intake/photos";

/** Foto de evidencia de un reporte del territorio del operador (JPEG normalizado; `?size=thumb` para miniaturas). */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/operacion/photos/[attachmentId]">) {
  return handle(async () => {
    const { attachmentId } = await ctx.params;
    const s = await requireOperatorSession();
    const deps = getDeps();
    const bytes = await getOperatorPhoto(deps.pool, deps.storage, { territoryId: s.territoryId, attachmentId, size: photoSize(req.nextUrl.searchParams.get("size")) });
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" },
    });
  });
}
