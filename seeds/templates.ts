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
    body: "¿Dónde está exactamente? Mandame tu ubicación o escribime la dirección (calle y número, o una esquina).",
    variables: [],
  },
  {
    key: "location_proposed",
    locale: "es",
    body: "Encontré «{{label}}». ¿Es ahí? Respondé «sí» para confirmar, o escribime otra dirección.",
    variables: ["label"],
  },
  {
    key: "location_not_found",
    locale: "es",
    body: "No pude ubicar «{{query}}». Probá con calle y número de puerta, otra esquina cercana, o mandame tu ubicación.",
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
    body: "Revisá la ficha: {{type}} en {{place}}. Si está bien, respondé «enviar». Si querés cambiar algo, escribime qué.",
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
  {
    key: "ask_location_retry",
    locale: "es",
    body: "Dale. Escribime la dirección correcta (calle y número, o una esquina) o mandame tu ubicación.",
    variables: [],
  },
  {
    key: "status_not_found",
    locale: "es",
    body: "No encontré un reporte con el código {{code}}. Revisá que esté bien escrito.",
    variables: ["code"],
  },
  {
    key: "status_rate_limited",
    locale: "es",
    body: "Hiciste muchas consultas seguidas. Probá de nuevo en un rato.",
    variables: [],
  },
];
