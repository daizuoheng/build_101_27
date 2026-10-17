// Respuestas cortas del ciudadano a una pregunta concreta del asistente («sí», «no», «enviar») y códigos de reporte.
// Puro y determinista: sirve igual en la web (donde además hay botones) y en canales de solo texto como WhatsApp.
// El LLM no participa: la confirmación la da la persona con sus palabras, comparadas contra el léxico de la política.

export type ReplyLexicon = { yes: string[]; no: string[]; send: string[] };
export type ReplyKind = "yes" | "no" | "send";

/** minúsculas, sin tildes, sin signos ni emojis, espacios simples. */
export function normalizeReply(text: string): string {
  return text
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

/**
 * Código de reporte mencionado en el texto (6 caracteres del alfabeto de `confirm.ts`). Para no confundir palabras
 * comunes («calles»), se acepta si tiene un dígito, si está escrito en mayúsculas o si el mensaje habla de un código.
 */
export function extractPublicCode(text: string): string | null {
  const mentionsCode = CODE_WORDS.test(text);
  for (const m of text.matchAll(TOKEN)) {
    const token = m[2];
    if (/\d/.test(token) || token === token.toUpperCase() || mentionsCode) return token.toUpperCase();
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
  return words.length > 0 && words.every((w) => addr.has(w) || ADDRESS_FILLER.has(w));
}
