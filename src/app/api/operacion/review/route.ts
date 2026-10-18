import { z } from "zod";
import { requireOperator, requireOperatorSession } from "@/server/access/internal-session";
import { getPool } from "@/server/db/pool";
import { handle } from "@/server/http";
import { getTerritoryView } from "@/server/intake/view";
import { listReviewQueue } from "@/server/review/queue";
import type { ReviewQueueResponse } from "@/shared/contracts/review";

const Query = z.object({ territory: z.string().min(1) });

/** Cola de revisión del territorio del operador (ítems abiertos, por prioridad). */
export async function GET(req: Request) {
  return handle(async () => {
    const s = await requireOperatorSession(); // antes de buscar el territorio: la respuesta no revela qué slugs existen
    const q = Query.parse(Object.fromEntries(new URL(req.url).searchParams));
    const pool = getPool();
    const t = await getTerritoryView(pool, { slug: q.territory });
    requireOperator(s, t.id);
    const body: ReviewQueueResponse = { items: await listReviewQueue(pool, t.id), generatedAt: new Date().toISOString() };
    return Response.json(body);
  });
}
