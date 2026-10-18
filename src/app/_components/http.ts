// Cliente HTTP mínimo para la UI. Los errores de la API llegan como { error, message }.

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: json !== undefined ? { "content-type": "application/json", ...rest.headers } : rest.headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      cache: "no-store",
    });
  } catch {
    throw new HttpError(0, "network", "No hay conexión. Revisá tu internet y probá de nuevo.");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* cuerpo no JSON */
  }
  if (!res.ok) {
    const body = (data ?? {}) as { error?: string; message?: string };
    throw new HttpError(res.status, body.error ?? `http_${res.status}`, body.message ?? "Algo salió mal. Probá de nuevo.");
  }
  return data as T;
}

/** Corta un pedido colgado: sin esto una carga periódica puede no terminar nunca y detener el polling. */
const REQUEST_TIMEOUT_MS = 15000;
export const withTimeout = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

export function errorMessage(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  return "Algo salió mal. Probá de nuevo.";
}
