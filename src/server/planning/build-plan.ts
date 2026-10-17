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

/** Unidades factibles para el incidente con la capacidad restante actual, o los motivos por los que no hay. */
function feasibility(
  i: PlanIncident,
  snapshot: PlanSnapshot,
  remaining: Map<string, number>,
  policy: PlanPolicy,
  now: Date,
): Feasibility {
  const strategy = (i.problemTypeId && snapshot.strategies[i.problemTypeId]) || snapshot.defaultStrategy;
  const capable = snapshot.units.filter((u) => hasAll(u, i.requiredCapabilities));
  if (capable.length === 0) return { strategy, candidates: [], reasons: ["no_capable_unit"] };
  if (strategy === "manual") return { strategy, candidates: [], reasons: ["manual_strategy"] };

  const failures = new Set<PendingReason>();
  const candidates: Candidate[] = [];

  if (strategy === "nearest_mobile") {
    // Familia móvil: unidades capaces con posición. Sin posición vigente no se compara distancia.
    const maxAgeMs = policy.position_max_age_min * MINUTE_MS;
    for (const u of capable) {
      if (!u.location || !u.locationUpdatedAt || now.getTime() - u.locationUpdatedAt.getTime() > maxAgeMs) {
        failures.add("stale_position");
        continue;
      }
      const distanceM = distanceMeters(u.location, i.location);
      const radius = Math.min(policy.max_distance_m, u.serviceRadiusM ?? Number.POSITIVE_INFINITY);
      if (distanceM > radius) {
        failures.add("out_of_radius");
        continue;
      }
      if ((remaining.get(u.id) ?? 0) <= 0) {
        failures.add("no_capacity");
        continue;
      }
      candidates.push({ unit: u, distanceM, key: [distanceM] });
    }
  } else {
    // Familia de zona: responsables del área y del tipo. Mayor precedencia primero, luego menor carga relativa.
    for (const u of capable) {
      const resp = u.zoneResponsibilities.filter((z) => z.areaId === i.areaId && z.problemTypeId === i.problemTypeId);
      if (!i.areaId || !i.problemTypeId || resp.length === 0) continue;
      if ((remaining.get(u.id) ?? 0) <= 0) {
        failures.add("no_capacity");
        continue;
      }
      const precedence = Math.max(...resp.map((z) => z.precedence));
      const load = (u.capacity - (remaining.get(u.id) ?? 0)) / u.capacity;
      candidates.push({ unit: u, distanceM: null, key: [-precedence, load] });
    }
    if (candidates.length === 0 && failures.size === 0) failures.add("no_zone_owner");
  }

  return { strategy, candidates, reasons: candidates.length ? [] : sortedReasons(failures) };
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

    const own = feasibility(incident, snapshot, remaining, policy, now);
    if (own.candidates.length === 0) {
      item.pendingReasons = own.reasons;
      pending.push({ incidentId: incident.id, reasons: own.reasons });
      return;
    }

    // Incidentes restantes cuya única unidad factible (con la capacidad actual) es cada unidad.
    const onlyOption = new Map<string, number>();
    for (const later of scored.slice(idx + 1)) {
      if (!eligible(later.incident)) continue;
      const f = feasibility(later.incident, snapshot, remaining, policy, now);
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
