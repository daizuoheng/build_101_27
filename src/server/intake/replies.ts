// Respuestas cortas del ciudadano a una pregunta concreta del asistente («sí», «no», «enviar») y códigos de reporte.
// Puro y determinista: sirve igual en la web (donde además hay botones) y en canales de solo texto como WhatsApp.
// El LLM no participa: la confirmación la da la persona con sus palabras, comparadas contra el léxico de la política.

export type ReplyLexicon = { yes: string[]; no: string[]; send: string[] };
export type ReplyKind = "yes" | "no" | "send";

/** minúsculas, sin tildes, sin signos ni emojis, espacios simples. */
// Emojis de asentimiento habituales en chats: equivalen a «ok» (si no, la normalización los borraría).
const AFFIRMATIVE_EMOJI = /(\u{1F44D}|\u{1F44C}|\u2705|\u2714\uFE0F?)(\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})?/gu;

export function normalizeReply(text: string): string {
  return text
    .replace(AFFIRMATIVE_EMOJI, " ok ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Clasifica un mensaje solo si es, entero, una respuesta corta del léxico («sí», «dale», «sí, es ahí»).
 * «sí, y además hay basura» no es una confirmación: sigue el flujo normal (evaluación de Jev y corrección).
 */
export function classifyReply(text: string, lexicon: ReplyLexicon): ReplyKind | null {
  const n = normalizeReply(text);
  if (!n) return null;
  const hit = (list: string[]) => list.some((w) => normalizeReply(w) === n);
  if (hit(lexicon.send)) return "send";
  if (hit(lexicon.yes)) return "yes";
  if (hit(lexicon.no)) return "no";
  return null;
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN = new RegExp(`(^|[^A-Za-z0-9])([${CODE_CHARS}${CODE_CHARS.toLowerCase()}]{6})(?![A-Za-z0-9])`, "g");
const CODE_WORDS = /\b(c[oó]digo|reporte|estado|n[uú]mero)\b/i;

// Palabras que acompañan una consulta de estado («¿cómo va mi reporte X?»). Si el mensaje trae otras, es relato.
const STATUS_WORDS = new Set(["estado", "de", "del", "mi", "el", "la", "codigo", "reporte", "numero", "como", "va", "esta", "que", "paso",
  "con", "consulta", "consultar", "quiero", "saber", "hola", "buenas", "por", "favor", "info", "novedades", "hay", "sobre", "y", "nro",
  "cual", "es", "en", "donde", "anda", "sigue", "gracias", "tardes", "dias", "noches", "saludos", "me", "podes", "decir", "puede", "ver"]);

/**
 * Código de reporte en una consulta de estado. Por defecto (atajo previo a Jev) el mensaje tiene que ser solo la consulta («estado de MKGWXM»,
 * «¿cómo va el reporte a9umuq?», «WKTA64»): un código dentro de un relato no la dispara. Además, para no confundir
 * palabras («CALLES»), el token necesita un dígito o que el mensaje hable de un código o reporte.
 * Los códigos nuevos siempre incluyen un dígito (`confirm.ts`).
 * Con `requireQueryOnly: false` (Jev ya clasificó el mensaje como consulta de estado) alcanza con encontrar el código,
 * así frases libres («¿en qué anda lo que mandé, el AB2CD9?») también funcionan.
 */
export function extractPublicCode(text: string, opts: { requireQueryOnly?: boolean } = {}): string | null {
  const requireQueryOnly = opts.requireQueryOnly ?? true;
  const words = normalizeReply(text).split(" ").filter(Boolean);
  const mentionsCode = CODE_WORDS.test(text);
  for (const m of text.matchAll(TOKEN)) {
    const token = m[2];
    if (!(/\d/.test(token) || mentionsCode)) continue;
    if (!requireQueryOnly) return token.toUpperCase();
    const rest = words.filter((w) => w !== token.toLowerCase());
    if (rest.every((w) => STATUS_WORDS.has(w))) return token.toUpperCase();
  }
  return null;
}

const ADDRESS_FILLER = new Set(["es", "en", "esta", "queda", "la", "el", "los", "las", "de", "del", "y", "e", "esq", "esquina", "con", "casi",
  "frente", "al", "a", "sobre", "calle", "avenida", "av", "bulevar", "bvar", "numero", "nro", "n", "puerta", "aca", "ahi", "por", "ahi", "creo", "que"]);

/**
 * ¿El mensaje es solo la dirección (más palabras de relleno)? «18 de julio y ejido» o «es en 18 de julio y ejido»
 * sí; «en 18 de julio, y está lleno de agua» no, porque agrega relato que tiene que quedar en la descripción.
 */
export function isOnlyAddress(text: string, address: string): boolean {
  const addr = new Set(normalizeReply(address).split(" "));
  const words = normalizeReply(text).split(" ").filter(Boolean);
  // Tiene que nombrar algo de la dirección: «creo que está por ahí» (solo relleno) no es una dirección.
  const named = words.filter((w) => addr.has(w) && !ADDRESS_FILLER.has(w));
  return named.length > 0 && words.every((w) => addr.has(w) || ADDRESS_FILLER.has(w));
}
