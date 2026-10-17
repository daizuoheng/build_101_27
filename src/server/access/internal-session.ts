import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { DomainError, forbidden } from "../errors";

export type InternalSession = { userId: string; role: "operator" | "unit"; territoryId: string; responseUnitId: string | null; username: string };

function options(): SessionOptions {
  const password = process.env.SESSION_SECRET;
  if (!password || password.length < 32) throw new Error("SESSION_SECRET falta o tiene menos de 32 caracteres");
  return {
    password,
    cookieName: "ru_internal",
    cookieOptions: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" },
    ttl: 60 * 60 * 14,
  };
}

export async function internalSessionStore() {
  return getIronSession<Partial<InternalSession>>(await cookies(), options());
}

export async function getInternalSession(): Promise<InternalSession | null> {
  const s = await internalSessionStore();
  return s.userId ? (s as InternalSession) : null;
}

const unauthorized = () => new DomainError("unauthorized", 401, "Iniciá sesión.");

/** Operador del territorio pedido. La identidad sale de la sesión del servidor, nunca del cliente. */
export async function requireOperator(territoryId: string): Promise<InternalSession> {
  const s = await getInternalSession();
  if (!s) throw unauthorized();
  if (s.role !== "operator" || s.territoryId !== territoryId) throw forbidden();
  return s;
}

/** Usuario de la unidad dueña del recurso. */
export async function requireUnit(unitId?: string): Promise<InternalSession & { responseUnitId: string }> {
  const s = await getInternalSession();
  if (!s) throw unauthorized();
  if (s.role !== "unit" || !s.responseUnitId || (unitId && s.responseUnitId !== unitId)) throw forbidden();
  return s as InternalSession & { responseUnitId: string };
}
