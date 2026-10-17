import bcrypt from "bcryptjs";
import { z } from "zod";
import { getPool } from "@/server/db/pool";
import { internalSessionStore } from "@/server/access/internal-session";
import { DomainError } from "@/server/errors";
import { handle } from "@/server/http";

const Body = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(200) });

export async function POST(req: Request) {
  return handle(async () => {
    const body = Body.parse(await req.json());
    const { rows } = await getPool().query<{ id: string; password_hash: string; role: "operator" | "unit"; territory_id: string; response_unit_id: string | null; slug: string }>(
      `select u.id, u.password_hash, u.role, u.territory_id, u.response_unit_id, t.slug
       from internal_users u join territories t on t.id = u.territory_id where u.username = $1`,
      [body.username],
    );
    const u = rows[0];
    if (!u || !(await bcrypt.compare(body.password, u.password_hash))) throw new DomainError("invalid_credentials", 401, "Usuario o contraseña incorrectos.");
    const s = await internalSessionStore();
    Object.assign(s, { userId: u.id, role: u.role, territoryId: u.territory_id, responseUnitId: u.response_unit_id, username: body.username });
    await s.save();
    return Response.json({ role: u.role, territory: u.slug, home: u.role === "operator" ? `/operacion?territory=${u.slug}` : "/unidad" });
  });
}

export async function DELETE() {
  return handle(async () => {
    (await internalSessionStore()).destroy();
    return Response.json({ ok: true });
  });
}
