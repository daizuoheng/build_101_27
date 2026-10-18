import { HttpError } from "@/app/_components/http";

/** Clave de idempotencia. `crypto.randomUUID` solo existe en contexto seguro (https o localhost); afuera, una equivalente. */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Qué se sabe de un pedido que falló. Solo un 4xx dice que el servidor no lo aplicó. Un error de red, un corte
 * mientras se leía el cuerpo (AbortError) o un 5xx (un proxy caído, o un error después de commitear) no dicen nada:
 * el pedido pudo haberse aplicado y su reintento tiene que llevar la misma clave.
 */
export function outcomeOf(err: unknown): "rejected" | "uncertain" {
  return err instanceof HttpError && err.status >= 400 && err.status < 500 ? "rejected" : "uncertain";
}

/** Cuánto vale una clave retenida como «el mismo pedido» después del último intento de resultado incierto. */
export const RETRY_WINDOW_MS = 2 * 60_000;

type Attempt = { key: string; version: number; at: number };

/**
 * Claves de reintento por acción (`signature`). Después de un resultado incierto (error de red, corte a mitad), la
 * misma acción reintentada dentro de la ventana reutiliza su clave y la versión que vio el operador: si el pedido
 * perdido sí se aplicó, el servidor lo reconoce en vez de aplicarlo de nuevo. Un éxito o un rechazo del servidor
 * descartan solo la clave de esa acción. Pasada la ventana, la misma acción es un pedido nuevo: el estado pudo dar la
 * vuelta (p. ej. desasociar → reasociar desde la cola → desasociar otra vez) y reutilizar la clave vieja haría que el
 * servidor lo tome por un reintento y no lo aplique.
 */
export class AttemptKeys {
  private readonly attempts = new Map<string, Attempt>();
  constructor(
    private readonly newKey: () => string = newIdempotencyKey,
    private readonly windowMs = RETRY_WINDOW_MS,
  ) {}

  take(signature: string, version: number, now = Date.now()): { key: string; version: number } {
    const prev = this.attempts.get(signature);
    if (prev && now - prev.at <= this.windowMs) return { key: prev.key, version: prev.version };
    const a = { key: this.newKey(), version, at: now };
    this.attempts.set(signature, a);
    return { key: a.key, version: a.version };
  }

  settle(signature: string, outcome: "applied" | "rejected" | "uncertain", now = Date.now()): void {
    if (outcome !== "uncertain") {
      this.attempts.delete(signature);
      return;
    }
    const a = this.attempts.get(signature);
    if (a) a.at = now;
  }
}
