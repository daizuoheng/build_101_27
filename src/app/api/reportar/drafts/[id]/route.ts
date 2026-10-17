import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getPool } from "@/server/db/pool";
import { getCitizenSession } from "@/server/access/citizen-session";
import { getDraftView } from "@/server/intake/view";
import { handle } from "@/server/http";
import { forbidden } from "@/server/errors";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/reportar/drafts/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const pool = getPool();
    const session = await getCitizenSession(pool, await cookies());
    if (!session) throw forbidden();
    return Response.json(await getDraftView(pool, id, session.id));
  });
}
