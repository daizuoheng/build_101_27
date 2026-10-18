import type { IncidentListItem } from "@/shared/contracts/incident";

// Prioridad legible sin color: etiqueta + símbolo de forma distinta.
export const PRIORITY: Record<IncidentListItem["priorityBand"], { label: string; symbol: string; rank: number }> = {
  high: { label: "Alta", symbol: "▲", rank: 0 },
  medium: { label: "Media", symbol: "◆", rank: 1 },
  low: { label: "Baja", symbol: "▼", rank: 2 },
  unknown: { label: "Sin evaluar", symbol: "○", rank: 3 },
};

export const STATUS: Record<IncidentListItem["status"], string> = {
  open: "Abierto",
  assigned: "Asignado",
  in_progress: "En atención",
  resolved: "Resuelto",
  archived: "Archivado",
};

export const REVIEW_KIND: Record<string, string> = {
  insufficient_evidence: "evidencia insuficiente",
  uncertain_duplicate: "posible duplicado",
  contradiction: "contradicción",
  low_confidence: "baja confianza",
  unknown_type: "tipo desconocido",
  no_compatible_unit: "sin unidad compatible",
  rejected_assignment: "orden rechazada",
  incompatible_assignment: "orden incompatible",
  provider_failure: "falla del proveedor",
  out_of_coverage: "fuera de cobertura",
};

/** Nombre de área legible: el GeoJSON trae mayúsculas («CORDON»); se muestra «Cordon». */
export function areaDisplay(name: string | null | undefined): string | null {
  if (!name) return null;
  if (name !== name.toLocaleUpperCase("es")) return name;
  return name
    .toLocaleLowerCase("es")
    .replace(/(^|[\s(\-/])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toLocaleUpperCase("es"));
}

/** Identificador corto y estable del incidente para leerlo y buscarlo (los incidentes no tienen código público). */
export function shortCode(id: string): string {
  return `#${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

/** Diferencia contra ayer en texto («+4 respecto a ayer», «igual que ayer»). */
export function versusYesterday(today: number, yesterday: number): string {
  const d = today - yesterday;
  if (d === 0) return "igual que ayer";
  return `${d > 0 ? "+" : "−"}${Math.abs(d)} respecto a ayer`;
}

export function age(iso: string, now: number): string {
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

// Plan de atención: textos de los motivos estables del planificador (src/shared/contracts/plan.ts).
export const PLAN_PENDING_REASON: Record<string, string> = {
  active_assignment: "Ya tiene una orden activa",
  dispatch_blocked: "Revisión pendiente: despacho bloqueado",
  manual_strategy: "Este tipo se asigna manualmente",
  no_capable_unit: "Sin equipo compatible",
  no_capacity: "Equipos compatibles ocupados",
  stale_position: "Ubicación de las cuadrillas desactualizada",
  out_of_radius: "Cuadrillas compatibles fuera de radio",
  no_zone_owner: "Sin responsable para esta zona y tipo",
  no_mobile_unit: "Ninguna cuadrilla móvil compatible",
  ambiguous_zone_owner: "Varios responsables de zona con igual precedencia",
  // Descartes del despacho al revalidar una propuesta (`plan_items.blocked_reason`, dispatch/apply-plan.ts).
  obsolete_plan: "Sin enviar: hay un plan más nuevo o en cálculo",
  revision_changed: "El incidente cambió: se recalcula el plan",
  incident_closed: "El incidente ya está cerrado",
  unit_unavailable: "La unidad propuesta ya no está disponible",
  not_mobile_unit: "La unidad propuesta no es móvil",
  unknown_type: "Tipo de problema sin determinar",
};

export const PLAN_PROPOSAL_REASON: Record<string, string> = {
  nearest_mobile: "Cuadrilla compatible más cercana",
  zone_owner: "Responsable de la zona",
  preserves_scarce_unit: "Reserva un equipo escaso para otro incidente",
  only_capable_unit: "Única unidad compatible disponible",
  lowest_load: "Responsable con menor carga",
};

export const PLAN_ITEM_STATUS: Record<string, string> = {
  proposed: "Propuesta (sin enviar)",
  executed: "Orden enviada",
  obsolete: "Obsoleta",
  blocked: "Pendiente de cuadrilla",
  queued: "En cola",
};

export const ASSIGNMENT_STATUS: Record<string, string> = {
  offered: "ofrecida",
  accepted: "aceptada",
  in_progress: "en curso",
};

export const PLAN_TRIGGER: Record<string, string> = {
  manual: "pedido del operador",
  periodic: "recálculo periódico",
};

/** Horas con un decimal, para el desglose de espera y bonus. */
export function hours(h: number): string {
  return `${h.toLocaleString("es-UY", { maximumFractionDigits: 1 })} h`;
}
