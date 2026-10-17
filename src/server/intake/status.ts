type Processing = "pending" | "running" | "done" | "error";
type Outcome = "applicable" | "unrelated" | "insufficient" | "out_of_coverage" | null;
type IncidentStatus = "open" | "assigned" | "in_progress" | "resolved" | "archived" | null;

/** Estado para el ciudadano, derivado solo de lo persistido. No promete movilización ni tiempos. */
export function statusLabel(processing: Processing, outcome: Outcome, incident: IncidentStatus): string {
  if (processing === "pending") return "recibido, pendiente de análisis";
  if (processing === "running") return "analizando";
  if (processing === "error") return "recibido; el análisis automático falló y lo revisa una persona";
  switch (outcome) {
    case "out_of_coverage":
      return "fuera de la zona que cubre este piloto";
    case "unrelated":
      return "no corresponde a un problema del espacio público";
    case "insufficient":
      return "en revisión por falta de información";
  }
  switch (incident) {
    case "assigned":
      return "asignado a una unidad";
    case "in_progress":
      return "en atención";
    case "resolved":
      return "resuelto";
    case "archived":
      return "archivado";
    case "open":
      return "registrado, esperando asignación";
  }
  return "registrado, en revisión";
}
