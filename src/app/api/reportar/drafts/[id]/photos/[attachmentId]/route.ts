import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getCitizenSession } from "@/server/access/citizen-session";
import { getDeps } from "@/server/deps";
import { forbidden } from "@/server/errors";
import { handle } from "@/server/http";
import { getOwnPhoto, photoSize } from "@/server/intake/photos";

/** Foto del propio borrador (JPEG normalizado). Privada: no se cachea en intermediarios. */
export async function GET(req: NextRequest, ctx: RouteContext<"/api/reportar/drafts/[id]/photos/[attachmentId]">) {
  return handle(async () => {
    const { id, attachmentId } = await ctx.params;
    const deps = getDeps();
    const session = await getCitizenSession(deps.pool, await cookies());
    if (!session) throw forbidden();
    const bytes = await getOwnPhoto(deps.pool, deps.storage, { reportId: id, sessionId: session.id, attachmentId, size: photoSize(req.nextUrl.searchParams.get("size")) });
    return new Response(new Uint8Array(bytes), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" },
    });
  });
}
