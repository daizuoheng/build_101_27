import type { IncidentListItem } from "@/shared/contracts/incident";
import type { ResolveAction, ReviewItemView, ReviewKind } from "@/shared/contracts/review";

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

// --- Cola de revisión (Tarea 14). Exhaustivos: si se agrega un tipo o una acción al contrato, tsc pide su etiqueta. ---

export const REVIEW_KIND: Record<ReviewKind, string> = {
  uncertain_duplicate: "Posible duplicado",
  insufficient_evidence: "Evidencia insuficiente",
  contradiction: "Reportes que se contradicen",
  low_confidence: "Clasificación dudosa",
  unknown_type: "Tipo desconocido",
  no_compatible_unit: "Sin unidad compatible",
  rejected_assignment: "Orden rechazada",
  incompatible_assignment: "Orden incompatible",
  provider_failure: "Falla del análisis",
  out_of_coverage: "Fuera de cobertura",
};

/** Etiqueta de un tipo de ítem que llega como texto (p. ej. `openReviewKinds` de la lista); si no hay, el código. */
export function reviewKindLabel(kind: string): string {
  return (REVIEW_KIND as Record<string, string>)[kind] ?? kind;
}

export type ReviewActionName = ResolveAction["action"];

export const REVIEW_ACTION: Record<ReviewActionName, string> = {
  link: "Asociar a este incidente",
  create_incident: "Crear incidente nuevo",
  set_type: "Corregir tipo",
  set_severity: "Corregir severidad",
  allow_dispatch: "Permitir despacho",
  // No se ofrece en el MVP (la API responde 400 action_not_available); está para que el registro sea exhaustivo.
  reassign: "Reasignar",
  retry: "Reintentar análisis",
  dismiss: "Descartar",
};

export const SEVERITY: Record<"low" | "medium" | "high", string> = { low: "Baja", medium: "Media", high: "Alta" };

/** Motivos estables con los que se abren los ítems (`review_items.reasons[].code`). */
export const REVIEW_REASON: Record<string, string> = {
  insufficient_evidence: "La evidencia no alcanza para confirmar el problema",
  contradiction: "El texto y la foto no coinciden",
  low_confidence: "La clasificación automática tiene baja confianza",
  unknown_type: "No se pudo determinar el tipo de problema",
  reports_contradict: "Los reportes del incidente se contradicen",
  evaluation_disagrees_with_manual_link: "La evaluación no coincide con la asociación manual",
  outside_territory: "La ubicación está fuera del territorio",
  provider_failure: "Falló el análisis automático",
  rejected_by_unit: "Rechazada por la cuadrilla",
  cancelled_by_operator: "Cancelada por un operador",
  unlinked_by_operator: "Un operador lo desasoció de su incidente",
  location_changed: "Cambió la ubicación del incidente",
  type_changed: "Cambió el tipo del incidente",
  active_hazard_detected: "Se detectó peligro activo",
  // Agrupación (compare-candidates): vienen como `<motivo>:<ref del candidato>`.
  no_candidates: "Sin incidentes candidatos",
  candidates_changed: "Los candidatos cambiaron durante el análisis",
  candidates_truncated: "Hay más candidatos de los que se compararon",
  uncertain: "No está claro si es el mismo problema que un candidato",
  weak_same: "Parecido débil con un incidente candidato",
  weak_different: "Diferencia débil con un incidente candidato",
  object_conflict: "El objeto no coincide con un candidato",
  place_conflict: "El lugar no coincide con un candidato",
  time_conflict: "El momento no coincide con un candidato",
};

/** Motivo legible de un ítem: el código traducido (sin la referencia al candidato) y el texto libre si lo hay. */
export function reviewReasonText(reason: Record<string, unknown>): string | null {
  const code = typeof reason.code === "string" ? reason.code : null;
  if (!code) return null;
  const label = REVIEW_REASON[code] ?? REVIEW_REASON[code.split(":")[0]] ?? code;
  const free = typeof reason.reason === "string" ? reason.reason.trim() : "";
  return free ? `${label}: «${free}»` : label;
}

/** Incidentes candidatos de un `uncertain_duplicate`, de todas sus evidencias y sin repetir. */
export function candidateIncidentIds(evidenceRefs: Record<string, unknown>[]): string[] {
  const ids = new Set<string>();
  for (const ref of evidenceRefs) {
    const list = ref.candidate_incident_ids;
    if (Array.isArray(list)) for (const id of list) if (typeof id === "string") ids.add(id);
  }
  return [...ids];
}

/** Incidente al que se refiere un ítem: el propio, o el de la orden (su evidencia lo nombra). Un reporte no tiene. */
export function relatedIncidentId(item: Pick<ReviewItemView, "entityType" | "entityId" | "evidenceRefs">): string | null {
  if (item.entityType === "incident") return item.entityId;
  if (item.entityType === "assignment") {
    const ref = item.evidenceRefs.find((r) => typeof r.incident_id === "string");
    return ref ? (ref.incident_id as string) : null;
  }
  return null;
}

/** Enlace al detalle de un incidente (Tarea 14, Task 2). */
export function incidentHref(incidentId: string, territorySlug: string): string {
  return `/operacion/incidentes/${encodeURIComponent(incidentId)}?territory=${encodeURIComponent(territorySlug)}`;
}

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
