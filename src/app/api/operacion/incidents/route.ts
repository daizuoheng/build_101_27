import { getPool } from "@/server/db/pool";
import { requireOperator } from "@/server/access/internal-session";
import { handle } from "@/server/http";
import { listIncidents } from "@/server/incidents/queries";
import { getTerritoryView } from "@/server/intake/view";
import { IncidentListQuery, type IncidentListResponse } from "@/shared/contracts/incident";

export async function GET(req: Request) {
  return handle(async () => {
    const q = IncidentListQuery.parse(Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== "")));
    const pool = getPool();
    const t = await getTerritoryView(pool, { slug: q.territory });
    await requireOperator(t.id);
    const [areas, types, incidents] = await Promise.all([
      pool.query<{ id: string; name: string }>("select id, name from areas where territory_id = $1 order by name", [t.id]),
      pool.query<{ slug: string; name: string }>(
        `select pt.slug, pt.name from problem_types pt join territory_problem_types tpt on tpt.problem_type_id = pt.id
         where tpt.territory_id = $1 and tpt.enabled and pt.active order by pt.sort_order`,
        [t.id],
      ),
      listIncidents(pool, t.id, q),
    ]);
    const body: IncidentListResponse = {
      territory: { slug: t.slug, name: t.name, areaLabel: t.areaLabel, center: t.center, zoom: t.zoom },
      filters: { areas: areas.rows, problemTypes: types.rows },
      incidents,
      generatedAt: new Date().toISOString(),
    };
    return Response.json(body);
  });
}
