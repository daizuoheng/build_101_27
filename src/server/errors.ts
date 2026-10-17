/** Error de dominio tipado: las rutas lo traducen a HTTP sin filtrar detalles internos. */
export class DomainError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const forbidden = (message = "No tenés acceso a este recurso.") => new DomainError("forbidden", 403, message);
export const notFound = (message = "No encontrado.") => new DomainError("not_found", 404, message);
export const conflict = (code: string, message: string) => new DomainError(code, 409, message);
export const badRequest = (code: string, message: string) => new DomainError(code, 400, message);
