import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getCitizenSession } from "@/server/access/citizen-session";
import { withTx } from "@/server/db/tx";
import { getDeps } from "@/server/deps";
import { forbidden } from "@/server/errors";
import { handle } from "@/server/http";
import { setLocation } from "@/server/intake/drafts";
import { runIntakeTurn } from "@/server/intake/orchestrator";
import { getDraftView } from "@/server/intake/view";
import { SetLocationBody } from "@/shared/contracts/intake";

/** Ubicación confirmada explícitamente por la persona; la IA nunca la confirma. */
export async function POST(req: NextRequest, ctx: RouteContext<"/api/reportar/drafts/[id]/location">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = SetLocationBody.parse(await req.json());
    const deps = getDeps();
    const session = await getCitizenSession(deps.pool, await cookies());
    if (!session) throw forbidden();
    await withTx((c) => setLocation(c, { reportId: id, sessionId: session.id, ...body }));
    await runIntakeTurn(deps, id);
    return Response.json(await getDraftView(deps.pool, id, session.id));
  });
}
