import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/pool";

export const CITIZEN_COOKIE = "ru_citizen";
const MAX_AGE_SEC = 60 * 60 * 24 * 180;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

type CookieStore = {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, opts: Record<string, unknown>): unknown;
};

/** Sesión ciudadana anónima: token opaco en cookie httpOnly, solo su hash en base. Sin identidad personal. */
export async function getCitizenSession(db: Db, cookies: CookieStore): Promise<{ id: string } | null> {
  const token = cookies.get(CITIZEN_COOKIE)?.value;
  if (!token) return null;
  const { rows } = await db.query<{ id: string }>(
    "update citizen_sessions set last_seen_at = now() where token_hash = $1 returning id",
    [hash(token)],
  );
  return rows[0] ?? null;
}

export async function getOrCreateCitizenSession(db: Db, cookies: CookieStore): Promise<{ id: string }> {
  const existing = await getCitizenSession(db, cookies);
  if (existing) return existing;
  const token = randomBytes(32).toString("base64url");
  const { rows } = await db.query<{ id: string }>(
    "insert into citizen_sessions (token_hash, channel) values ($1, 'web') returning id",
    [hash(token)],
  );
  cookies.set(CITIZEN_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
  return rows[0];
}
