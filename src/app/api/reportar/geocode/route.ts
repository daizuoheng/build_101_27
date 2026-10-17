import { cookies } from "next/headers";
import { getPool } from "@/server/db/pool";
import { getCitizenSession } from "@/server/access/citizen-session";
import { getActivePolicy } from "@/server/config/policies";
import { badRequest, forbidden } from "@/server/errors";
import { geocode } from "@/server/geo/geocoder";
import { handle } from "@/server/http";
import { getOwnedReport } from "@/server/intake/drafts";

/** Dirección escrita → punto propuesto, acotado al territorio del borrador. La persona confirma después. */
export async function GET(req: Request) {
  return handle(async () => {
    const params = new URL(req.url).searchParams;
    const draftId = params.get("draftId") ?? "";
    const q = (params.get("q") ?? "").trim();
    if (q.length < 3 || q.length > 200) throw badRequest("invalid_query", "Escribí una dirección o esquina.");
    const pool = getPool();
    const session = await getCitizenSession(pool, await cookies());
    if (!session) throw forbidden();
    const r = await getOwnedReport(pool, draftId, session.id);
    const intake = await getActivePolicy(pool, r.territory_id!, "intake");
    const hit = await geocode(pool, { query: q, territoryId: r.territory_id!, policy: intake.config.geocoder }).catch(() => null);
    return Response.json(hit ? { ...hit, label: q } : null);
  });
}
