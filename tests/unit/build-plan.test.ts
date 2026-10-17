import { describe, expect, it } from "vitest";
import { buildPlan } from "@/server/planning/build-plan";
import type { PlanIncident, PlanPolicy, PlanSnapshot, PlanUnit } from "@/shared/contracts/plan";

// Fixtures en memoria: los valores de política se fijan acá solo para el test (en la app salen de policy_versions).
const policy: PlanPolicy = { window_hours: 24, weight_hours: 2, cap_hours: 12, max_distance_m: 3000, position_max_age_min: 30 };
const NOW = new Date("2026-10-17T20:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

// Puntos en Montevideo; ~0.001° de longitud ≈ 91 m a esta latitud.
const P = {
  centro: { lon: -56.1916, lat: -34.9035 },
  cordon: { lon: -56.1805, lat: -34.9012 },
  cerca: (base: { lon: number; lat: number }, dLon: number) => ({ lon: base.lon + dLon, lat: base.lat }),
};

function incident(id: string, over: Partial<PlanIncident> = {}): PlanIncident {
  return {
    id,
    revision: 1,
    band: "medium",
    activeHazard: false,
    createdAt: hoursAgo(1),
    sourcesInWindow: 1,
    dispatchBlocked: false,
    problemTypeId: "pt-basura",
    requiredCapabilities: ["limpieza"],
    location: P.centro,
    areaId: "area-centro",
    ...over,
  };
}

function unit(id: string, over: Partial<PlanUnit> = {}): PlanUnit {
  return {
    id,
    kind: "mobile_crew",
    capabilities: ["limpieza"],
    capacity: 1,
    activeOrders: 0,
    location: P.centro,
    locationUpdatedAt: minutesAgo(1),
    serviceRadiusM: 3000,
    zoneResponsibilities: [],
    ...over,
  };
}

function snapshot(over: Partial<PlanSnapshot>): PlanSnapshot {
  return { territoryId: "t-1", incidents: [], units: [], activeAssignments: [], strategies: {}, defaultStrategy: "nearest_mobile", ...over };
}

const proposalFor = (r: ReturnType<typeof buildPlan>, incidentId: string) => r.proposals.find((p) => p.incidentId === incidentId) ?? null;
const pendingFor = (r: ReturnType<typeof buildPlan>, incidentId: string) => r.pending.find((p) => p.incidentId === incidentId) ?? null;
const order = (r: ReturnType<typeof buildPlan>) => r.queue.map((q) => q.incidentId);

describe("buildPlan", () => {
  it("(a) conserva la unidad polivalente para el bache aunque esté más cerca de la basura (ejemplo del ALCANCE)", () => {
    const basuraAt = P.centro;
    const r = buildPlan(
      snapshot({
        incidents: [
          // la basura va primero en la cola (más antigua), así la decisión cae sobre ella
          incident("basura", { createdAt: hoursAgo(2), location: basuraAt }),
          incident("bache", { createdAt: hoursAgo(1), problemTypeId: "pt-bache", requiredCapabilities: ["vialidad"], location: P.cerca(basuraAt, 0.01) }),
        ],
        units: [
          unit("u-limpieza", { capabilities: ["limpieza"], location: P.cerca(basuraAt, -0.015) }), // ~1,4 km
          unit("u-polivalente", { capabilities: ["limpieza", "vialidad"], location: P.cerca(basuraAt, 0.002) }), // ~180 m
        ],
      }),
      policy,
      NOW,
    );
    expect(order(r)).toEqual(["basura", "bache"]);
    expect(proposalFor(r, "basura")).toMatchObject({ unitId: "u-limpieza" });
    expect(proposalFor(r, "basura")?.reasons).toContain("preserves_scarce_unit");
    expect(proposalFor(r, "bache")).toMatchObject({ unitId: "u-polivalente" });
    expect(r.pending).toEqual([]);
  });

  it("(a') una prioridad superior mantiene precedencia aunque consuma el recurso escaso", () => {
    const r = buildPlan(
      snapshot({
        incidents: [
          incident("bache-bajo", { band: "low", problemTypeId: "pt-bache", requiredCapabilities: ["vialidad"] }),
          incident("basura-alta", { band: "high" }),
        ],
        units: [unit("u-polivalente", { capabilities: ["limpieza", "vialidad"] })],
      }),
      policy,
      NOW,
    );
    expect(order(r)).toEqual(["basura-alta", "bache-bajo"]);
    expect(proposalFor(r, "basura-alta")).toMatchObject({ unitId: "u-polivalente" });
    expect(pendingFor(r, "bache-bajo")?.reasons).toEqual(["no_capacity"]);
  });

  it("(b) 4 fuentes en 3 h adelanta a 1 fuente en 6 h dentro de la misma banda", () => {
    const r = buildPlan(
      snapshot({
        incidents: [
          incident("una-fuente", { createdAt: hoursAgo(6), sourcesInWindow: 1 }),
          incident("cuatro-fuentes", { createdAt: hoursAgo(3), sourcesInWindow: 4 }),
        ],
      }),
      policy,
      NOW,
    );
    expect(order(r)).toEqual(["cuatro-fuentes", "una-fuente"]);
    const [first, second] = r.queue;
    expect(first.score).toEqual({ waitHours: 3, sources: 4, bonusHours: 4, score: 7 });
    expect(second.score).toEqual({ waitHours: 6, sources: 1, bonusHours: 0, score: 6 });
    expect(first.position).toBe(1);
    expect(second.position).toBe(2);
  });

  it("(c) un fuego activo con 1 fuente precede a una basura de banda alta con 100 fuentes", () => {
    const r = buildPlan(
      snapshot({
        incidents: [
          incident("basura-100", { band: "high", sourcesInWindow: 100, createdAt: hoursAgo(10) }),
          incident("fuego", { band: "medium", activeHazard: true, sourcesInWindow: 1, requiredCapabilities: ["fuego"] }),
        ],
      }),
      policy,
      NOW,
    );
    expect(order(r)).toEqual(["fuego", "basura-100"]);
  });

  it("(d) fuego sin unidad con capacidad `fuego` queda pendiente con no_capable_unit y no se propone la cuadrilla de limpieza", () => {
    const r = buildPlan(
      snapshot({
        incidents: [incident("fuego", { band: "high", activeHazard: true, requiredCapabilities: ["fuego", "limpieza"] })],
        units: [unit("u-limpieza", { capabilities: ["limpieza"] })],
      }),
      policy,
      NOW,
    );
    expect(r.proposals).toEqual([]);
    expect(pendingFor(r, "fuego")?.reasons).toEqual(["no_capable_unit"]);
    expect(r.queue[0]).toMatchObject({ incidentId: "fuego", proposal: null, pendingReasons: ["no_capable_unit"] });
  });

  it("(e) unidad móvil con posición de hace 40 min ⇒ stale_position", () => {
    const r = buildPlan(
      snapshot({ incidents: [incident("basura")], units: [unit("u-limpieza", { locationUpdatedAt: minutesAgo(40) })] }),
      policy,
      NOW,
    );
    expect(r.proposals).toEqual([]);
    expect(pendingFor(r, "basura")?.reasons).toEqual(["stale_position"]);
  });

  it("(e') unidad móvil capaz fuera del radio ⇒ out_of_radius", () => {
    const r = buildPlan(
      snapshot({ incidents: [incident("basura")], units: [unit("u-limpieza", { location: P.cerca(P.centro, 0.05) })] }), // ~4,6 km
      policy,
      NOW,
    );
    expect(pendingFor(r, "basura")?.reasons).toEqual(["out_of_radius"]);
  });

  it("(f) responsable de zona sin GPS recibe por area_responsibilities", () => {
    const r = buildPlan(
      snapshot({
        incidents: [incident("luz", { problemTypeId: "pt-alumbrado", requiredCapabilities: ["alumbrado"], areaId: "area-cordon", location: P.cordon })],
        units: [
          unit("u-oficina", {
            kind: "zone_office",
            capabilities: ["alumbrado"],
            capacity: 5,
            location: null,
            locationUpdatedAt: null,
            serviceRadiusM: null,
            zoneResponsibilities: [{ areaId: "area-cordon", problemTypeId: "pt-alumbrado", precedence: 1 }],
          }),
        ],
        strategies: { "pt-alumbrado": "zone_owner" },
      }),
      policy,
      NOW,
    );
    expect(proposalFor(r, "luz")).toMatchObject({ unitId: "u-oficina", distanceM: null });
    expect(proposalFor(r, "luz")?.reasons).toContain("zone_owner");
  });

  it("(f') estrategia de zona sin responsable para el área ⇒ no_zone_owner", () => {
    const r = buildPlan(
      snapshot({
        incidents: [incident("luz", { problemTypeId: "pt-alumbrado", requiredCapabilities: ["alumbrado"], areaId: "area-otra" })],
        units: [
          unit("u-oficina", {
            kind: "zone_office",
            capabilities: ["alumbrado"],
            location: null,
            locationUpdatedAt: null,
            zoneResponsibilities: [{ areaId: "area-cordon", problemTypeId: "pt-alumbrado", precedence: 1 }],
          }),
        ],
        strategies: { "pt-alumbrado": "zone_owner" },
      }),
      policy,
      NOW,
    );
    expect(pendingFor(r, "luz")?.reasons).toEqual(["no_zone_owner"]);
  });

  it("(g) mismo snapshot dos veces (y con entradas reordenadas) ⇒ resultado idéntico", () => {
    const base = snapshot({
      incidents: [
        incident("i-3", { createdAt: hoursAgo(2) }),
        incident("i-1", { createdAt: hoursAgo(2) }),
        incident("i-2", { band: "high" }),
        incident("i-4", { problemTypeId: "pt-bache", requiredCapabilities: ["vialidad"] }),
      ],
      units: [unit("u-b", { capacity: 2 }), unit("u-a", { capabilities: ["limpieza", "vialidad"] })],
    });
    const reordered: PlanSnapshot = { ...base, incidents: [...base.incidents].reverse(), units: [...base.units].reverse() };
    const r1 = buildPlan(base, policy, NOW);
    expect(buildPlan(base, policy, NOW)).toEqual(r1);
    expect(buildPlan(reordered, policy, NOW)).toEqual(r1);
    // empate total de banda, score y fecha: decide el id
    expect(order(r1).indexOf("i-1")).toBeLessThan(order(r1).indexOf("i-3"));
  });

  it("(h) el bonus de corroboración satura en cap_hours", () => {
    const r = buildPlan(snapshot({ incidents: [incident("i", { sourcesInWindow: 1000, createdAt: hoursAgo(5) })] }), policy, NOW);
    expect(r.queue[0].score).toEqual({ waitHours: 5, sources: 1000, bonusHours: 12, score: 17 });
  });

  it("incidentes con orden activa o despacho bloqueado entran en la cola sin propuesta y no consumen capacidad del plan", () => {
    const r = buildPlan(
      snapshot({
        incidents: [
          incident("asignado", { band: "high" }),
          incident("bloqueado", { band: "high", dispatchBlocked: true }),
          incident("libre", { band: "low" }),
        ],
        // la orden activa ya está contada en activeOrders de su unidad
        units: [unit("u-ocupada", { activeOrders: 1 }), unit("u-libre")],
        activeAssignments: [{ incidentId: "asignado", unitId: "u-ocupada" }],
      }),
      policy,
      NOW,
    );
    expect(order(r)).toEqual(["asignado", "bloqueado", "libre"]);
    expect(pendingFor(r, "asignado")?.reasons).toEqual(["active_assignment"]);
    expect(pendingFor(r, "bloqueado")?.reasons).toEqual(["dispatch_blocked"]);
    expect(proposalFor(r, "libre")).toMatchObject({ unitId: "u-libre" });
  });

  it("estrategia manual ⇒ pendiente con manual_strategy", () => {
    const r = buildPlan(
      snapshot({ incidents: [incident("i")], units: [unit("u")], strategies: { "pt-basura": "manual" } }),
      policy,
      NOW,
    );
    expect(pendingFor(r, "i")?.reasons).toEqual(["manual_strategy"]);
  });

  it("capacidad mayor que uno: una unidad recibe tantas propuestas como plazas libres", () => {
    const r = buildPlan(
      snapshot({
        incidents: [incident("i-1", { createdAt: hoursAgo(3) }), incident("i-2", { createdAt: hoursAgo(2) }), incident("i-3", { createdAt: hoursAgo(1) })],
        units: [unit("u", { capacity: 3, activeOrders: 1 })],
      }),
      policy,
      NOW,
    );
    expect(r.proposals.map((p) => p.incidentId)).toEqual(["i-1", "i-2"]);
    expect(pendingFor(r, "i-3")?.reasons).toEqual(["no_capacity"]);
  });

  it("entre móviles con igual costo de oportunidad elige la más cercana", () => {
    const r = buildPlan(
      snapshot({
        incidents: [incident("i")],
        units: [unit("u-lejos", { location: P.cerca(P.centro, 0.01) }), unit("u-cerca", { location: P.cerca(P.centro, 0.002) })],
      }),
      policy,
      NOW,
    );
    const p = proposalFor(r, "i");
    expect(p?.unitId).toBe("u-cerca");
    expect(p?.reasons).toContain("nearest_mobile");
    expect(p?.distanceM).toBeGreaterThan(150);
    expect(p?.distanceM).toBeLessThan(220);
  });

  it("entre responsables de zona usa precedencia y después carga", () => {
    const zone = (precedence: number) => [{ areaId: "area-centro", problemTypeId: "pt-alumbrado", precedence }];
    const base: Partial<PlanUnit> = { kind: "zone_office", capabilities: ["alumbrado"], capacity: 5, location: null, locationUpdatedAt: null };
    const luz = incident("luz", { problemTypeId: "pt-alumbrado", requiredCapabilities: ["alumbrado"] });
    const strategies = { "pt-alumbrado": "zone_owner" as const };

    const byPrecedence = buildPlan(
      snapshot({ incidents: [luz], units: [unit("u-a", { ...base, zoneResponsibilities: zone(1) }), unit("u-b", { ...base, zoneResponsibilities: zone(2) })], strategies }),
      policy,
      NOW,
    );
    expect(proposalFor(byPrecedence, "luz")?.unitId).toBe("u-b");

    const byLoad = buildPlan(
      snapshot({
        incidents: [luz],
        units: [unit("u-a", { ...base, activeOrders: 3, zoneResponsibilities: zone(1) }), unit("u-b", { ...base, activeOrders: 1, zoneResponsibilities: zone(1) })],
        strategies,
      }),
      policy,
      NOW,
    );
    expect(proposalFor(byLoad, "luz")).toMatchObject({ unitId: "u-b" });
    expect(proposalFor(byLoad, "luz")?.reasons).toContain("lowest_load");
  });
});
