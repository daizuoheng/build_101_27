// Acciones válidas por tipo de ítem y entidad (Tarea 14). Pura y sin `pg`: la importa también la UI de la cola.
// `reassign` no se ofrece en el MVP: asignar a una unidad elegida necesita un despacho manual que hoy no existe;
// una orden rechazada se resuelve con `allow_dispatch` y el planificador vuelve a elegir.

import type { ResolveAction, ReviewKind } from "@/shared/contracts/review";

export type ReviewAction = ResolveAction["action"];
export type ReviewEntityType = "report" | "incident" | "assignment";

const EVALUATION_ON_INCIDENT: ReviewAction[] = ["set_type", "set_severity", "allow_dispatch", "dismiss"];
const PROMOTE_REPORT: ReviewAction[] = ["create_incident", "dismiss"];

const TABLE: Record<ReviewKind, Partial<Record<ReviewEntityType, ReviewAction[]>>> = {
  uncertain_duplicate: { report: ["link", "create_incident", "dismiss"] },
  insufficient_evidence: { report: PROMOTE_REPORT, incident: ["allow_dispatch", "set_type", "set_severity", "dismiss"] },
  contradiction: { incident: EVALUATION_ON_INCIDENT, report: PROMOTE_REPORT },
  low_confidence: { incident: EVALUATION_ON_INCIDENT, report: PROMOTE_REPORT },
  unknown_type: { incident: EVALUATION_ON_INCIDENT, report: PROMOTE_REPORT },
  no_compatible_unit: { incident: ["allow_dispatch", "set_type", "dismiss"] },
  rejected_assignment: { incident: ["allow_dispatch", "set_type", "set_severity", "dismiss"] },
  incompatible_assignment: { assignment: ["allow_dispatch", "dismiss"] },
  provider_failure: { report: ["retry", "dismiss"], incident: ["retry", "dismiss"] },
  out_of_coverage: { report: ["dismiss"] },
};

/** Acciones que la cola ofrece para un ítem; cualquier otra se rechaza con 400 `action_not_available`. */
export function actionsFor(kind: ReviewKind, entityType: ReviewEntityType): ReviewAction[] {
  return [...(TABLE[kind]?.[entityType] ?? [])];
}
