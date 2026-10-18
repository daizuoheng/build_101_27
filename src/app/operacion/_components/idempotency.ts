/** Clave de idempotencia. `crypto.randomUUID` solo existe en contexto seguro (https o localhost); afuera, una equivalente. */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
