// Valores iniciales de política del piloto (diseño §7, ALCANCE §4 y §6). Hipótesis a calibrar, no constantes del código.

const judgement = {
  intent: {
    instructions:
      "The state holds messages a citizen sent to a municipal urban-problem reporting service (Spanish, Uruguay), plus optional photos. What is the citizen doing?",
    criteria: {
      report: "Describes or adds information about a problem in public space (street, sidewalk, lighting, waste, trees, drains, signs).",
      status_query: "Asks about the status or follow-up of a report already sent.",
      other: "Greeting, test, unrelated topic, or a request outside public-space problems.",
    },
  },
  applicability: {
    instructions:
      "Considering all messages and photos together, is there enough evidence of a concrete problem in public space that a municipal crew could address?",
    criteria: {
      applicable: "A concrete public-space problem is described or visible.",
      unrelated: "Not about a public-space problem (private matters, complaints about people, spam, jokes).",
      insufficient: "Possibly a public-space problem, but the evidence is too vague to know what or where.",
    },
  },
  severity: {
    instructions:
      "How severe is the reported problem for people using the space? Judge only from the evidence; do not assume facts not stated or visible.",
    criteria: {
      low: "Limited impact; passage remains available.",
      medium: "Partial obstruction or deterioration that makes use difficult.",
      high: "Total blockage or evidence of significant risk to people.",
      undetermined: "Not enough context to judge impact.",
    },
  },
  active_fire: {
    instructions: "Is there an active fire right now according to the messages or photos?",
    criteria: {
      yes: "Flames or active smoke are reported as happening now, or are visible.",
      no: "Evidence indicates no fire now (e.g. burnt remains only, or unrelated problem).",
      undeterminable: "The evidence does not allow knowing whether there is fire now.",
    },
  },
  passage: {
    instructions: "Is passage for pedestrians or vehicles blocked by the problem?",
    criteria: {
      total: "Completely blocked.",
      partial: "Partially blocked or hard to pass.",
      none: "Passage is not affected.",
      undetermined: "Cannot tell from the evidence.",
    },
  },
  accessibility: {
    instructions:
      "Does the evidence show that an accessible route (ramp, curb cut, sidewalk, pedestrian crossing) is affected for people with reduced mobility?",
    criteria: {
      affected: "An accessible route is blocked or unusable.",
      not_affected: "Accessible routes are not affected.",
      undetermined: "Cannot tell from the evidence.",
    },
  },
  location_in_text: {
    instructions: "Do the citizen's messages state where the problem is?",
    criteria: {
      precise: "A street address with number, a street corner/intersection, or a named landmark precise enough to geocode.",
      vague: "Only a vague reference (e.g. 'near my house', 'in my neighborhood', a street without number or corner).",
      absent: "No location is mentioned.",
    },
  },
  photo_quality: {
    instructions: "Is there a photo, and is it useful to see the reported problem?",
    criteria: {
      useful: "At least one photo clearly shows the problem.",
      insufficient: "There are photos but they are blurry, dark, too far, or do not show the problem.",
      no_photo: "No photo was provided.",
    },
  },
  text_photo_consistency: {
    instructions: "Do the photos agree with what the text describes?",
    criteria: {
      consistent: "Text and photos describe the same problem.",
      contradiction: "Photos show something different from or incompatible with the text.",
      not_evaluable: "There is no photo or no text to compare.",
    },
  },
  problem_type: {
    instructions:
      "Which category of the active catalog best describes the main problem? Use 'other' for a public-space problem outside the catalog and 'unknown' when it cannot be determined.",
    other: "A public-space problem that fits none of the catalog categories.",
    unknown: "The evidence does not allow determining the category.",
  },
};

export const policies = {
  intake: {
    jev_timeout_ms: 8000,
    max_clarification_rounds: 2,
    require_photo: false,
    thresholds: { intent: 0.6, location_in_text: 0.6, photo_quality: 0.6, contradiction: 0.6 },
    photo: { max_bytes: 15 * 1024 * 1024, accepted_types: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] },
    geocoder: {
      provider: "nominatim",
      base_url: "https://nominatim.openstreetmap.org",
      country_codes: "uy",
      query_suffix: "Montevideo, Uruguay",
      min_interval_ms: 1100,
      timeout_ms: 5000,
    },
    llm: {
      model: "deepseek-flash",
      instructions_version: "intake-v1",
      max_output_tokens: 300,
      timeout_ms: 8000,
      extra_body: { thinking: { type: "disabled" } },
    },
  },
  evaluation: {
    provider: "jev",
    model: "jev-1.14.0",
    image_header: true,
    timeout_ms: 15000,
    questions: judgement,
    noul_facts: [
      { key: "photo_shows_fire", instructions: "Does any photo show flames or active smoke?" },
      { key: "recurring_problem_claimed", instructions: "Does the citizen say this problem has been happening for a long time or keeps recurring?" },
    ],
    review: { min_applicability: 0.9, min_type: 0.9, min_contradiction: 0.6 },
  },
  grouping: { radius_m: 30, max_candidates: 5, same_threshold: 0.9, different_threshold: 0.8, conflict_band: 0.15 },
  priority: {
    high: { severity: ["high"], active_hazard: true, passage: ["total"], accessibility: ["affected"] },
    medium: { severity: ["medium"] },
    promote_low_to_medium_after_hours: 48,
  },
  planning: { window_hours: 24, weight_hours: 2, cap_hours: 12, replan_interval_min: 5 },
  dispatch: {
    min_applicability: 0.9,
    min_type_confidence: 0.9,
    max_distance_m: 3000,
    position_max_age_min: 30,
    default_strategy: "nearest_mobile",
    strategies: { alumbrado: "zone_owner" } as Record<string, "nearest_mobile" | "zone_owner" | "manual">,
  },
  textgen: {
    enabled: true,
    model: "deepseek-flash",
    instructions_version: "textgen-v1",
    max_output_tokens: 300,
    timeout_ms: 10000,
    extra_body: { thinking: { type: "disabled" } },
    max_chars: { title: 90, summary: 420, explain_priority: 420 },
    // Descripciones de reportes que se pasan como referencias, las más antiguas primero.
    max_references: 5,
    // El texto se rechaza (y va la plantilla) si promete despacho o tiempos: eso lo decide el backend, no el LLM.
    forbidden_patterns: [
      "\\b(llega(r|rá|rán|n)?|arriba(rá|rán)?|demora(rá)?)\\b[^.]{0,40}\\b(minutos?|horas?|hoy|mañana)\\b",
      "\\ben camino\\b",
      "\\b(despachad|asignad|enviad)[oa]s?\\b",
    ],
    instructions: {
      common:
        "Redactás textos breves en español rioplatense para el operador de un servicio municipal de reportes urbanos. Usá solo los hechos y las referencias del json de entrada. No inventes estado, asignaciones, unidades, despacho, plazos ni tiempos de llegada. Copiá los nombres de lugares, barrios y tipos de problema exactamente como vienen, sin corregirlos ni traducirlos. No incluyas datos personales. Si un hecho falta, no lo supongas.",
      output:
        'Respondé solo json con la forma {"body": string, "references": string[]}. En "references" van los id de las referencias de la entrada en las que te basaste, y ningún otro.',
      title: "Escribí un título de hasta {{max_chars}} caracteres con el tipo de problema y el lugar. Sin punto final.",
      summary:
        "Escribí un resumen de una a tres oraciones, de hasta {{max_chars}} caracteres: qué pasa, dónde y cuántos reportes lo respaldan, según los hechos y las descripciones de las referencias.",
      explain_priority:
        "Explicá en una o dos oraciones, de hasta {{max_chars}} caracteres, por qué el incidente tiene esa prioridad, usando solo los motivos dados. Citá como referencias los códigos de motivo que usaste.",
    },
    labels: {
      unknown_type: "Problema sin clasificar",
      unknown_place: "ubicación sin barrio",
      list_separator: ", ",
      no_reasons: "sin motivos de riesgo registrados",
      severity: { low: "baja", medium: "media", high: "alta", undetermined: "sin determinar" },
      passage: { total: "bloqueado", partial: "parcialmente obstruido", none: "libre", undetermined: "sin determinar" },
      accessibility: { affected: "afectada", not_affected: "no afectada", undetermined: "sin determinar" },
      active_hazard: { true: "sí", false: "no" },
      priority_band: { high: "alta", medium: "media", low: "baja", unknown: "sin determinar" },
      priority_rule: {
        severity_high: "severidad alta",
        active_hazard: "peligro activo",
        passage_blocked: "paso bloqueado",
        accessibility_affected: "accesibilidad afectada",
        severity_medium: "severidad media",
        promoted_by_age: "antigüedad sin atender",
      },
    },
  },
};
