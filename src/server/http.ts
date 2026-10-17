import { ZodError } from "zod";
import { DomainError } from "./errors";
import type { ApiError } from "@/shared/contracts/intake";

const err = (status: number, error: string, message: string) => Response.json({ error, message } satisfies ApiError, { status });

/** Traduce errores de dominio y de validación a respuestas JSON tipadas; el resto es 500 sin detalles internos. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DomainError) return err(e.status, e.code, e.message);
    if (e instanceof ZodError) return err(400, "invalid_request", "Datos inválidos.");
    if (e instanceof SyntaxError) return err(400, "invalid_json", "Cuerpo JSON inválido.");
    console.error(e);
    return err(500, "internal", "Algo falló de nuestro lado. Probá de nuevo en un momento.");
  }
}
