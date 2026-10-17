import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getCitizenSession } from "@/server/access/citizen-session";
import { withTx } from "@/server/db/tx";
import { getDeps } from "@/server/deps";
import { badRequest, forbidden } from "@/server/errors";
import { handle } from "@/server/http";
import { attachPhoto } from "@/server/intake/drafts";
import { runIntakeTurn } from "@/server/intake/orchestrator";
import { getDraftView } from "@/server/intake/view";

export async function POST(req: NextRequest, ctx: RouteContext<"/api/reportar/drafts/[id]/attachments">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const form = await req.formData();
    const file = form.get("file");
    const clientMessageId = String(form.get("clientMessageId") ?? "");
    if (!(file instanceof File) || file.size === 0) throw badRequest("file_required", "Elegí una foto.");
    if (clientMessageId.length < 8) throw badRequest("client_message_id_required", "Falta el identificador del envío.");
    const deps = getDeps();
    const session = await getCitizenSession(deps.pool, await cookies());
    if (!session) throw forbidden();
    const bytes = Buffer.from(await file.arrayBuffer());
    const res = await withTx((c) =>
      attachPhoto(c, deps.storage, { reportId: id, sessionId: session.id, clientMessageId, bytes, contentType: file.type || "application/octet-stream" }),
    );
    if (!res.duplicate) await runIntakeTurn(deps, id);
    return Response.json(await getDraftView(deps.pool, id, session.id));
  });
}
