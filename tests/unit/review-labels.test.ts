import { describe, expect, it } from "vitest";
import { REVIEW_KINDS } from "@/shared/contracts/review";
import { REVIEW_ACTION, REVIEW_KIND, candidateIncidentIds, relatedIncidentId, reviewKindLabel, reviewReasonText } from "@/app/operacion/_components/labels";

describe("etiquetas de la cola de revisión", () => {
  it("hay una etiqueta por cada tipo de ítem y por cada acción", () => {
    for (const k of REVIEW_KINDS) expect(REVIEW_KIND[k]).toBeTruthy();
    for (const a of ["link", "create_incident", "set_type", "set_severity", "allow_dispatch", "retry", "dismiss"] as const) expect(REVIEW_ACTION[a]).toBeTruthy();
    expect(REVIEW_KIND.uncertain_duplicate).toBe("Posible duplicado");
    expect(REVIEW_ACTION.link).toBe("Asociar a este incidente");
  });

  it("un tipo desconocido se muestra con su código", () => {
    expect(reviewKindLabel("rejected_assignment")).toBe("Orden rechazada");
    expect(reviewKindLabel("algo_nuevo")).toBe("algo_nuevo");
  });

  it("traduce el motivo, ignora la referencia al candidato y suma el texto libre", () => {
    expect(reviewReasonText({ code: "weak_same:c2" })).toBe("Parecido débil con un incidente candidato");
    expect(reviewReasonText({ code: "rejected_by_unit", reason: "Sin equipo" })).toBe("Rechazada por la cuadrilla: «Sin equipo»");
    expect(reviewReasonText({ code: "rejected_by_unit", reason: null })).toBe("Rechazada por la cuadrilla");
    expect(reviewReasonText({ code: "codigo_raro" })).toBe("codigo_raro");
    expect(reviewReasonText({})).toBeNull();
  });

  it("junta los candidatos de todas las evidencias sin repetir", () => {
    const refs = [
      { report_id: "r", candidate_incident_ids: ["a", "b"] },
      { candidate_incident_ids: ["b", "c", 7] },
      { previous_incident_id: "z" },
    ];
    expect(candidateIncidentIds(refs)).toEqual(["a", "b", "c"]);
    expect(candidateIncidentIds([])).toEqual([]);
  });

  it("el incidente relacionado sale de la entidad o, para una orden, de su evidencia", () => {
    expect(relatedIncidentId({ entityType: "incident", entityId: "i1", evidenceRefs: [] })).toBe("i1");
    expect(relatedIncidentId({ entityType: "assignment", entityId: "a1", evidenceRefs: [{ incident_id: "i2" }] })).toBe("i2");
    expect(relatedIncidentId({ entityType: "assignment", entityId: "a1", evidenceRefs: [] })).toBeNull();
    expect(relatedIncidentId({ entityType: "report", entityId: "r1", evidenceRefs: [{ report_id: "r1" }] })).toBeNull();
  });
});
