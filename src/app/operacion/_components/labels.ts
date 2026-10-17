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

export function age(iso: string, now: number): string {
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}
