import type { AssignmentAction, AssignmentStatus, UnitAssignmentCard } from "@/shared/contracts/assignment";

type Band = UnitAssignmentCard["incident"]["priorityBand"];

// Prioridad legible sin color: texto + símbolo + clase de color.
export const PRIORITY: Record<Band, { label: string; symbol: string; className: string }> = {
  high: { label: "Prioridad alta", symbol: "▲", className: "badge-high" },
  medium: { label: "Prioridad media", symbol: "◆", className: "badge-medium" },
  low: { label: "Prioridad baja", symbol: "▼", className: "badge-low" },
  unknown: { label: "Sin evaluar", symbol: "○", className: "badge-unknown" },
};

export const STATUS: Record<AssignmentStatus, string> = {
  offered: "Nueva orden",
  accepted: "Aceptada",
  in_progress: "En curso",
  completed: "Completada",
  rejected: "Rechazada",
  cancelled: "Cancelada",
};

/** Por qué la prioridad es la que es (reglas de la política). */
export const PRIORITY_RULE: Record<string, string> = {
  severity_high: "gravedad alta",
  active_hazard: "peligro activo",
  passage_blocked: "paso bloqueado",
  accessibility_affected: "accesibilidad afectada",
  severity_medium: "gravedad media",
  promoted_by_age: "lleva tiempo sin atender",
};

/** Por qué se eligió a esta unidad (PROPOSAL_REASONS). */
export const PROPOSAL_REASON: Record<string, string> = {
  nearest_mobile: "Es la unidad disponible más cercana",
  zone_owner: "La zona es responsabilidad de esta unidad",
  preserves_scarce_unit: "Así otras unidades quedan libres para casos que solo ellas pueden atender",
  only_capable_unit: "Es la única unidad con la capacidad necesaria",
  lowest_load: "Es la unidad con menos carga",
};

export const ACTION: Record<Exclude<AssignmentAction, "cancel">, { label: string; done: string; className: string; confirm?: string }> = {
  accept: { label: "Aceptar", done: "Orden aceptada.", className: "btn-success" },
  start: { label: "Iniciar trabajo", done: "Trabajo iniciado.", className: "btn-primary" },
  complete: { label: "Completar", done: "Orden completada.", className: "btn-success", confirm: "¿El trabajo quedó terminado en el lugar?" },
  reject: { label: "Rechazar", done: "Orden rechazada. Vuelve a planificación.", className: "btn-ghost-danger", confirm: "¿Por qué la rechazás? (opcional)" },
};

export function ago(iso: string, now: number): string {
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (min < 1) return "recién";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} días`;
}

export function distance(m: number | null): string | null {
  if (m === null) return null;
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`;
}
