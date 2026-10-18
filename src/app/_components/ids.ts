/**
 * Id aleatorio para claves de idempotencia y de mensajes del cliente. `crypto.randomUUID` solo existe en contexto
 * seguro (https o localhost): abriendo la app por http en la red local (celulares en una demo) no está, así que
 * afuera se arma uno equivalente con `getRandomValues`, que sí está.
 */
export function newClientId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // UUID v4 con el mismo formato que randomUUID (versión y variante en sus bits).
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
