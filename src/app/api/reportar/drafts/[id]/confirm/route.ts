import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getPool } from "@/server/db/pool";
import { withTx } from "@/server/db/tx";
import { getCitizenSession } from "@/server/access/citizen-session";
import { forbidden } from "@/server/errors";
import { handle } from "@/server/http";
import { confirmReport } from "@/server/intake/confirm";
import { getDraftView } from "@/server/intake/view";
import { ConfirmBody } from "@/shared/contracts/intake";

export async function POST(req: NextRequest, ctx: RouteContext<"/api/reportar/drafts/[id]/confirm">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const body = ConfirmBody.parse(await req.json());
    const pool = getPool();
    const session = await getCitizenSession(pool, await cookies());
    if (!session) throw forbidden();
    await withTx((c) => confirmReport(c, { reportId: id, sessionId: session.id, idempotencyKey: body.idempotencyKey }));
    return Response.json(await getDraftView(pool, id, session.id));
  });
}
