import { getPool } from "@/server/db/pool";
import { requireUnit } from "@/server/access/internal-session";
import { handle } from "@/server/http";
import { getUnitInbox } from "@/server/unit/inbox";

/** Bandeja de la unidad autenticada (UnitInboxResponse). La UI hace polling. */
export async function GET() {
  return handle(async () => {
    const session = await requireUnit();
    const body = await getUnitInbox(getPool(), session.responseUnitId);
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  });
}
