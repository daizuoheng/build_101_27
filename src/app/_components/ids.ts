/**
 * Id aleatorio para claves de idempotencia y de mensajes del cliente. `crypto.randomUUID` solo existe en contexto
 * seguro (https o localhost): abriendo la app por http en la red local (celulares en una demo) no está, así que
 * afuera se arma uno equivalente con `getRandomValues`, que sí está.
 */
export function newClientId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
