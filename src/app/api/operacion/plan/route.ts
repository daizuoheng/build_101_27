import { z } from "zod";
import { getPool } from "@/server/db/pool";
import { requireOperator, requireOperatorSession } from "@/server/access/internal-session";
import { handle } from "@/server/http";
import { getTerritoryView } from "@/server/intake/view";
import { getLatestPlan, requestReplan } from "@/server/planning/queries";
import type { PlanResponse } from "@/shared/contracts/plan";

const TerritoryParam = z.object({ territory: z.string().min(1) });

/** Último plan del territorio. Solo lectura: los filtros de la vista no cambian el universo planificado. */
export async function GET(req: Request) {
  return handle(async () => {
    const s = await requireOperatorSession(); // antes de buscar el territorio: la respuesta no revela qué slugs existen
    const q = TerritoryParam.parse(Object.fromEntries(new URL(req.url).searchParams));
    const pool = getPool();
    const t = await getTerritoryView(pool, { slug: q.territory });
    requireOperator(s, t.id);
    const body: PlanResponse = await getLatestPlan(pool, t.id);
    return Response.json(body);
  });
}

/** «Actualizar plan»: encola el recálculo del territorio (job `plan`). Responde sin esperar el cálculo. */
export async function POST(req: Request) {
  return handle(async () => {
    const s = await requireOperatorSession(); // ídem GET
    const b = TerritoryParam.parse(await req.json());
    const pool = getPool();
    const t = await getTerritoryView(pool, { slug: b.territory });
    requireOperator(s, t.id);
    const res = await requestReplan(pool, { territoryId: t.id, actorId: s.userId });
    return Response.json(res, { status: 202 });
  });
}
