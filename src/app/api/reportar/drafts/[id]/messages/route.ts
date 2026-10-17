import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getCitizenSession } from "@/server/access/citizen-session";
import { withTx } from "@/server/db/tx";
import { getDeps } from "@/server/deps";
import { forbidden } from "@/server/errors";
import { handle } from "@/server/http";
import { appendCitizenMessage } from "@/server/intake/drafts";
import { runIntakeTurn } from "@/server/intake/orchestrator";
import { getDraftView } from "@/server/intake/view";
import { PostMessageBody } from "@/shared/contracts/intake";

/** Persiste el mensaje (idempotente) y después corre el turno: Jev primero, LLM solo si la rama lo pide. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/reportar/drafts/[id]/messages">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = PostMessageBody.parse(await req.json());
    const deps = getDeps();
    const session = await getCitizenSession(deps.pool, await cookies());
    if (!session) throw forbidden();
    const res = await withTx((c) => appendCitizenMessage(c, { reportId: id, sessionId: session.id, clientMessageId: body.clientMessageId, body: body.body }));
    if (!res.duplicate) await runIntakeTurn(deps, id);
    return Response.json(await getDraftView(deps.pool, id, session.id));
  });
}
