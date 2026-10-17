// Plantillas de mensajes (fallback del LLM y textos fijos). Variables con {{nombre}}.

export const templates: { key: string; locale: string; body: string; variables: string[] }[] = [
  {
    key: "welcome",
    locale: "es",
    body: "Hola. Contame qué problema viste en {{territory}}: qué es y dónde está. Si podés, sumá una foto.",
    variables: ["territory"],
  },
  {
    key: "greeting_other",
    locale: "es",
    body: "Este canal recibe problemas en el espacio público: baches, basura, alumbrado, veredas, árboles caídos, desagües, cartelería o contenedores. Si viste alguno, contame qué es y dónde.",
    variables: [],
  },
  {
    key: "ask_location",
    locale: "es",
    body: "¿Dónde está exactamente? Podés usar tu ubicación, marcar el punto en el mapa o escribir una dirección o esquina.",
    variables: [],
  },
  {
    key: "location_proposed",
    locale: "es",
    body: "Encontré «{{label}}». Revisá el punto en el mapa y confirmalo, o movelo si no es ahí.",
    variables: ["label"],
  },
  {
    key: "location_not_found",
    locale: "es",
    body: "No pude ubicar «{{query}}». Marcá el punto en el mapa o probá con calle y número de puerta.",
    variables: ["query"],
  },
  {
    key: "ask_better_photo",
    locale: "es",
    body: "No llego a ver bien el problema. ¿Podés mandar otra foto más cercana o contarme un poco más qué pasa?",
    variables: [],
  },
  {
    key: "ask_description",
    locale: "es",
    body: "¿Qué es lo que pasa? Contame el problema con tus palabras.",
    variables: [],
  },
  {
    key: "pending_analysis",
    locale: "es",
    body: "Recibido. Estoy analizando tu mensaje; en unos segundos sigo.",
    variables: [],
  },
  {
    key: "draft_ready",
    locale: "es",
    body: "Revisá la ficha: {{type}} en {{place}}. Si está bien, tocá «Enviar reporte». Si querés cambiar algo, escribime.",
    variables: ["type", "place"],
  },
  {
    key: "confirmation",
    locale: "es",
    body: "Reporte enviado. Tu código es {{code}}. Podés ver su estado desde este mismo navegador. Recibirlo no significa que ya esté resuelto.",
    variables: ["code"],
  },
  {
    key: "status_card",
    locale: "es",
    body: "Reporte {{code}}: {{status}}.",
    variables: ["code", "status"],
  },
  {
    key: "active_hazard_notice",
    locale: "es",
    body: "Si hay fuego o riesgo para personas ahora, no esperes a este canal: {{emergency}}",
    variables: ["emergency"],
  },
  {
    key: "out_of_coverage",
    locale: "es",
    body: "Ese punto queda fuera de la zona que atiende este piloto ({{territory}}). Guardamos el reporte, pero no podemos asignarlo.",
    variables: ["territory"],
  },
  // Respaldo de los textos generados (textgen) cuando el LLM falla o está apagado por política.
  {
    key: "textgen_title",
    locale: "es",
    body: "{{problem_type}} — {{place}}",
    variables: ["problem_type", "place"],
  },
  {
    key: "textgen_summary",
    locale: "es",
    body: "{{problem_type}} en {{place}}: {{active_hazard}}, paso {{passage}}, accesibilidad {{accessibility}}. Severidad {{severity}}. Reportes vinculados: {{report_count}}.",
    variables: ["problem_type", "place", "active_hazard", "passage", "accessibility", "severity", "report_count"],
  },
  {
    key: "textgen_explain_priority",
    locale: "es",
    body: "Prioridad {{priority}} por: {{reasons}}.",
    variables: ["priority", "reasons"],
  },
];
