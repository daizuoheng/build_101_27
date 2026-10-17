// Planificador determinista (Tarea 11). Pura: sin IO, sin IA, sin reloj propio (usa `now`).
// Reglas: ALCANCE §6 «Planificador operativo» y ARQUITECTURA «Planificador determinista».
//
// 1. Orden lexicográfico: peligro activo, banda, score desc, createdAt asc, id asc.
//    score = horas de espera + min(cap_hours, weight_hours × log2(max(1, fuentes en ventana))).
// 2. Elegibilidad: con orden activa o despacho bloqueado entran en la cola sin propuesta.
// 3. La estrategia del tipo elige la familia de recursos (móviles por distancia o responsables de zona) antes de comparar.
// 4. Asignación voraz en el orden de la cola: mínimo costo de oportunidad (otros incidentes que perderían su única
//    unidad factible), luego distancia (móviles) o precedencia y carga (zona), luego id. La capacidad propuesta se
//    descuenta antes de pasar al siguiente incidente y el costo se recalcula en cada paso.

import {
  PENDING_REASONS,
  PRIORITY_BANDS,
  type BuildPlan,
  type BuildPlanResult,
  type DispatchStrategy,
  type PendingReason,
  type PlanIncident,
  type PlanPolicy,
  type PlanProposal,
  type PlanQueueItem,
  type PlanSnapshot,
  type PlanUnit,
  type ProposalReason,
  type ScoreBreakdown,
} from "@/shared/contracts/plan";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const EARTH_RADIUS_M = 6_371_008.8;

/** Candidata factible para un incidente; `key` ordena dentro de la familia (menor es mejor). */
type Candidate = { unit: PlanUnit; distanceM: number | null; key: number[] };

type Feasibility = { strategy: DispatchStrategy; candidates: Candidate[]; reasons: PendingReason[] };

/**
 * Parte estática de la factibilidad de un incidente, calculada UNA vez: no depende de la capacidad restante.
 * `pool` son las unidades que pasan todos los filtros estáticos (capacidad, posición/radio o responsabilidad de zona),
 * en el mismo orden de recorrido que el loop original; `distanceM`/`precedence` ya resueltos. Solo falta aplicar el
 * filtro mutable de capacidad (`remaining > 0`) para obtener las candidatas reales.
 */
type StaticCandidate = { unit: PlanUnit; distanceM: number | null; precedence: number | null };
type StaticFeasibility = {
  strategy: DispatchStrategy;
  /** Motivos terminales (no_capable_unit, manual_strategy): nunca habrá candidatas, independientemente de capacidad. */
  terminalReasons: PendingReason[] | null;
  pool: StaticCandidate[];
  /** Fallas estáticas acumuladas en orden de recorrido (móvil: stale_position/out_of_radius). */
  staticFailures: PendingReason[];
  /** Estrategia de zona sin responsable para área/tipo: emite no_zone_owner cuando no hay candidatas ni otras fallas. */
  zoneNoOwner: boolean;
};

export function scoreIncident(i: Pick<PlanIncident, "createdAt" | "sourcesInWindow">, policy: PlanPolicy, now: Date): ScoreBreakdown {
  const waitHours = Math.max(0, (now.getTime() - i.createdAt.getTime()) / HOUR_MS);
  const sources = Math.max(0, i.sourcesInWindow);
  const bonusHours = Math.min(policy.cap_hours, policy.weight_hours * Math.log2(Math.max(1, sources)));
  return { waitHours, sources, bonusHours, score: waitHours + bonusHours };
}

export function distanceMeters(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

const bandRank = (b: PlanIncident["band"]) => PRIORITY_BANDS.indexOf(b);
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function compareKeys(a: number[], b: number[]): number {
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    const d = (a[k] ?? 0) - (b[k] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Motivos ordenados como en el contrato y sin repetir, para que el resultado sea estable. */
function sortedReasons(set: Set<PendingReason>): PendingReason[] {
  return PENDING_REASONS.filter((r) => set.has(r));
}

const hasAll = (unit: PlanUnit, required: string[]) => required.every((c) => unit.capabilities.includes(c));

/**
 * Parte estática de la factibilidad: estrategia, unidades capaces, posición/radio o responsabilidad de zona y claves
 * de orden que NO dependen de la capacidad restante. Se calcula una vez por incidente antes del loop voraz.
 */
function staticFeasibility(i: PlanIncident, snapshot: PlanSnapshot, policy: PlanPolicy, now: Date): StaticFeasibility {
  const strategy = (i.problemTypeId && snapshot.strategies[i.problemTypeId]) || snapshot.defaultStrategy;
  const capable = snapshot.units.filter((u) => hasAll(u, i.requiredCapabilities));
  if (capable.length === 0) return { strategy, terminalReasons: ["no_capable_unit"], pool: [], staticFailures: [], zoneNoOwner: false };
  if (strategy === "manual") return { strategy, terminalReasons: ["manual_strategy"], pool: [], staticFailures: [], zoneNoOwner: false };

  const staticFailures: PendingReason[] = [];
  const pool: StaticCandidate[] = [];

  if (strategy === "nearest_mobile") {
    // Familia móvil: unidades capaces con posición. Sin posición vigente no se compara distancia.
    const maxAgeMs = policy.position_max_age_min * MINUTE_MS;
    for (const u of capable) {
      if (!u.location || !u.locationUpdatedAt || now.getTime() - u.locationUpdatedAt.getTime() > maxAgeMs) {
        staticFailures.push("stale_position");
        continue;
      }
      const distanceM = distanceMeters(u.location, i.location);
      const radius = Math.min(policy.max_distance_m, u.serviceRadiusM ?? Number.POSITIVE_INFINITY);
      if (distanceM > radius) {
        staticFailures.push("out_of_radius");
        continue;
      }
      pool.push({ unit: u, distanceM, precedence: null });
    }
    return { strategy, terminalReasons: null, pool, staticFailures, zoneNoOwner: false };
  }

  // Familia de zona: responsables del área y del tipo. Mayor precedencia primero, luego menor carga relativa.
  for (const u of capable) {
    const resp = u.zoneResponsibilities.filter((z) => z.areaId === i.areaId && z.problemTypeId === i.problemTypeId);
    if (!i.areaId || !i.problemTypeId || resp.length === 0) continue;
    const precedence = Math.max(...resp.map((z) => z.precedence));
    pool.push({ unit: u, distanceM: null, precedence });
  }
  // Sin ninguna unidad responsable (el pool estático está vacío) la única falla posible es no_zone_owner.
  return { strategy, terminalReasons: null, pool, staticFailures, zoneNoOwner: pool.length === 0 };
}

/**
 * Deriva las candidatas reales aplicando SOLO el filtro mutable de capacidad (`remaining > 0`) sobre el pool estático.
 * Reproduce exactamente la semántica del `feasibility` original: motivos de pendiente, `load` de zona (que depende de
 * la capacidad restante) y el orden de recorrido.
 */
function applyCapacity(sf: StaticFeasibility, remaining: Map<string, number>): Feasibility {
  if (sf.terminalReasons) return { strategy: sf.strategy, candidates: [], reasons: sf.terminalReasons };

  const failures = new Set<PendingReason>(sf.staticFailures);
  const candidates: Candidate[] = [];

  for (const sc of sf.pool) {
    if ((remaining.get(sc.unit.id) ?? 0) <= 0) {
      failures.add("no_capacity");
      continue;
    }
    if (sf.strategy === "nearest_mobile") {
      candidates.push({ unit: sc.unit, distanceM: sc.distanceM, key: [sc.distanceM as number] });
    } else {
      const load = (sc.unit.capacity - (remaining.get(sc.unit.id) ?? 0)) / sc.unit.capacity;
      candidates.push({ unit: sc.unit, distanceM: null, key: [-(sc.precedence as number), load] });
    }
  }

  if (sf.strategy !== "nearest_mobile" && candidates.length === 0 && failures.size === 0 && sf.zoneNoOwner) {
    failures.add("no_zone_owner");
  }

  return { strategy: sf.strategy, candidates, reasons: candidates.length ? [] : sortedReasons(failures) };
}

/**
 * Costo de oportunidad de consumir una plaza de `unitId`: cuántos de los incidentes restantes, cuya única unidad
 * factible es esa, quedarían sin plaza.
 */
function opportunityCost(unitId: string, remaining: Map<string, number>, onlyOption: Map<string, number>): number {
  const dependents = onlyOption.get(unitId) ?? 0;
  const slotsAfter = (remaining.get(unitId) ?? 0) - 1;
  return Math.max(0, dependents - slotsAfter);
}

export const buildPlan: BuildPlan = (snapshot, policy, now) => {
  const scored = snapshot.incidents.map((i) => ({ incident: i, score: scoreIncident(i, policy, now) }));
  scored.sort(
    (a, b) =>
      Number(b.incident.activeHazard) - Number(a.incident.activeHazard) ||
      bandRank(a.incident.band) - bandRank(b.incident.band) ||
      b.score.score - a.score.score ||
      a.incident.createdAt.getTime() - b.incident.createdAt.getTime() ||
      byId(a.incident.id, b.incident.id),
  );

  const remaining = new Map(snapshot.units.map((u) => [u.id, Math.max(0, u.capacity - u.activeOrders)]));
  const assigned = new Set(snapshot.activeAssignments.map((a) => a.incidentId));
  const eligible = (i: PlanIncident) => !assigned.has(i.id) && !i.dispatchBlocked;

  // Parte estática de la factibilidad calculada UNA vez por incidente elegible (no depende de `remaining`).
  // Dentro del loop solo se aplica el filtro mutable de capacidad, evitando el O(n²·u) de recomputar distancias.
  const staticByIndex = scored.map(({ incident }) => (eligible(incident) ? staticFeasibility(incident, snapshot, policy, now) : null));

  const queue: PlanQueueItem[] = [];
  const proposals: PlanProposal[] = [];
  const pending: BuildPlanResult["pending"] = [];

  scored.forEach(({ incident, score }, idx) => {
    const item: PlanQueueItem = {
      incidentId: incident.id,
      position: idx + 1,
      band: incident.band,
      activeHazard: incident.activeHazard,
      score,
      proposal: null,
      pendingReasons: [],
    };
    queue.push(item);

    if (!eligible(incident)) {
      item.pendingReasons = assigned.has(incident.id) ? ["active_assignment"] : ["dispatch_blocked"];
      pending.push({ incidentId: incident.id, reasons: item.pendingReasons });
      return;
    }

    const own = applyCapacity(staticByIndex[idx]!, remaining);
    if (own.candidates.length === 0) {
      item.pendingReasons = own.reasons;
      pending.push({ incidentId: incident.id, reasons: own.reasons });
      return;
    }

    // Incidentes restantes cuya única unidad factible (con la capacidad actual) es cada unidad. Se recorre por índice
    // sobre `scored` (sin asignar un array nuevo) y solo se evalúa el filtro mutable de capacidad sobre el pool estático.
    const onlyOption = new Map<string, number>();
    for (let j = idx + 1; j < scored.length; j++) {
      const laterStatic = staticByIndex[j];
      if (!laterStatic) continue; // no elegible
      const f = applyCapacity(laterStatic, remaining);
      if (f.candidates.length === 1) {
        const id = f.candidates[0].unit.id;
        onlyOption.set(id, (onlyOption.get(id) ?? 0) + 1);
      }
    }

    const ranked = own.candidates
      .map((c) => ({ ...c, cost: opportunityCost(c.unit.id, remaining, onlyOption) }))
      .sort((a, b) => a.cost - b.cost || compareKeys(a.key, b.key) || byId(a.unit.id, b.unit.id));
    const chosen = ranked[0];

    const reasons: ProposalReason[] = [own.strategy === "zone_owner" ? "zone_owner" : "nearest_mobile"];
    if (ranked.length === 1) reasons.push("only_capable_unit");
    // Se descartó una opción mejor por distancia/precedencia para no dejar a otro incidente sin su única unidad.
    if (ranked.some((c) => c.cost > chosen.cost && compareKeys(c.key, chosen.key) < 0)) reasons.push("preserves_scarce_unit");
    if (
      own.strategy === "zone_owner" &&
      ranked.some((c) => c.unit.id !== chosen.unit.id && c.cost === chosen.cost && c.key[0] === chosen.key[0] && c.key[1] > chosen.key[1])
    ) {
      reasons.push("lowest_load");
    }

    const proposal: PlanProposal = { incidentId: incident.id, unitId: chosen.unit.id, distanceM: chosen.distanceM, reasons };
    remaining.set(chosen.unit.id, (remaining.get(chosen.unit.id) ?? 0) - 1);
    item.proposal = proposal;
    proposals.push(proposal);
  });

  return { queue, proposals, pending };
};
