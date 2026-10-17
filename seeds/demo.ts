import type { Pool } from "pg";
import { withTx } from "../src/server/db/tx";
import { appendEvent } from "../src/server/events/append";
import { demoUnits } from "./demo-units";
import { demoPasswords, seedDemoUsers } from "./demo-users";

/**
 * Unidades y usuarios de demo, atómico: todo o nada en una transacción, y las contraseñas se validan antes.
 * Idempotente por (territorio, slug): nunca cambia capacidad, estado ni posición de una unidad existente
 * (eso es operación). Sin fecha de posición: ver `refreshDemoPositions`.
 */
export async function seedDemo(pool: Pool, territorySlug: string): Promise<{ unitsCreated: string[]; usersCreated: string[] }> {
  const units = demoUnits[territorySlug];
  if (!units) throw new Error(`no hay unidades de demo para '${territorySlug}'`);
  const passwords = demoPasswords();
  return withTx(async (c) => {
    const t = await c.query<{ id: string }>("select id from territories where slug = $1", [territorySlug]);
    if (!t.rows[0]) throw new Error(`territorio inexistente: ${territorySlug} (correr seed primero)`);
    const territoryId = t.rows[0].id;
    const created: string[] = [];
    for (const u of units) {
      const ins = await c.query<{ id: string }>(
        `insert into response_units (territory_id, slug, name, unit_kind, capacity, location, service_radius_m, is_demo)
         values ($1, $2, $3, $4, $5, case when $6::float8 is null then null else st_setsrid(st_makepoint($6, $7), 4326)::geography end, $8, true)
         on conflict (territory_id, slug) do nothing returning id`,
        [territoryId, u.slug, u.name, u.unitKind, u.capacity, u.position?.lon ?? null, u.position?.lat ?? null, u.serviceRadiusM ?? null],
      );
      if (!ins.rows[0]) continue; // existente: no se toca
      const unitId = ins.rows[0].id;
      created.push(u.slug);
      for (const cap of u.capabilities) {
        const r = await c.query(
          "insert into unit_capabilities (unit_id, capability_id) select $1, id from capabilities where slug = $2 on conflict do nothing",
          [unitId, cap],
        );
        if (!r.rowCount) throw new Error(`capacidad inexistente: ${cap}`);
      }
      if (u.zones) {
        for (const ext of u.zones.areaExternalIds) {
          for (const pt of u.zones.problemTypes) {
            const r = await c.query(
              `insert into area_responsibilities (area_id, problem_type_id, unit_id, precedence)
               select a.id, p.id, $1, $2 from areas a, problem_types p
               where a.territory_id = $3 and a.external_id = $4 and p.slug = $5
               on conflict do nothing`,
              [unitId, u.zones.precedence, territoryId, ext, pt],
            );
            if (!r.rowCount) throw new Error(`área ${ext} o tipo ${pt} inexistente (¿import-areas?)`);
          }
        }
      }
      await appendEvent(c, { entityType: "response_unit", entityId: unitId, kind: "demo_seeded", actorType: "system" });
    }
    const usersCreated = await seedDemoUsers(c, territorySlug, passwords);
    return { unitsCreated: created, usersCreated };
  }, pool);
}

/** Acción explícita y auditada: marca vigentes las posiciones SIMULADAS de las unidades de demo. */
export async function refreshDemoPositions(pool: Pool, territorySlug: string): Promise<number> {
  return withTx(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `update response_units u set location_updated_at = now(), updated_at = now()
       from territories t where t.id = u.territory_id and t.slug = $1 and u.is_demo and u.location is not null
       returning u.id`,
      [territorySlug],
    );
    for (const r of rows) {
      await appendEvent(c, { entityType: "response_unit", entityId: r.id, kind: "demo_position_refreshed", actorType: "system", data: { simulated: true } });
    }
    return rows.length;
  }, pool);
}

/**
 * Borra TODO lo operativo (reportes, incidentes, órdenes, planes, revisión, jobs, corridas de IA, eventos)
 * y conserva configuración, unidades y usuarios. Destructivo: separado de las seeds.
 */
export async function resetDemo(pool: Pool): Promise<void> {
  await withTx(async (c) => {
    await c.query(`truncate assignments, plan_items, plan_runs, incident_overrides, report_incident_links, incident_assessments,
      grouping_decisions, review_items, generated_texts, incidents, report_evaluations, attachments, messages, conversations,
      reports, citizen_sessions, ai_runs, llm_runs, jobs, events`);
    await c.query("update response_units set location_updated_at = null where is_demo");
  }, pool);
}
