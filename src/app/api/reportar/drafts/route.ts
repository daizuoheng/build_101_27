import { cookies } from "next/headers";
import { getPool } from "@/server/db/pool";
import { withTx } from "@/server/db/tx";
import { getCitizenSession, getOrCreateCitizenSession } from "@/server/access/citizen-session";
import { createDraft } from "@/server/intake/drafts";
import { getTerritoryView, getDraftView, listMyReports } from "@/server/intake/view";
import { renderTemplate } from "@/server/config/templates";
import { appendAssistantMessage, getReport } from "@/server/intake/drafts";
import { handle } from "@/server/http";
import { badRequest } from "@/server/errors";
import { CreateDraftBody } from "@/shared/contracts/intake";

/** Reportes propios de la sesión en el territorio (más reciente primero). Sin sesión, lista vacía. */
export async function GET(req: Request) {
  return handle(async () => {
    const slug = new URL(req.url).searchParams.get("territory");
    if (!slug) throw badRequest("territory_required", "Falta el territorio.");
    const pool = getPool();
    const territory = await getTerritoryView(pool, { slug });
    const session = await getCitizenSession(pool, await cookies());
    return Response.json(session ? await listMyReports(pool, session.id, territory.id) : []);
  });
}

/** Nuevo borrador con su conversación y el saludo de plantilla. */
export async function POST(req: Request) {
  return handle(async () => {
    const body = CreateDraftBody.parse(await req.json());
    const pool = getPool();
    const territory = await getTerritoryView(pool, { slug: body.territorySlug });
    const session = await getOrCreateCitizenSession(pool, await cookies());
    const id = await withTx(async (c) => {
      const reportId = await createDraft(c, { sessionId: session.id, territoryId: territory.id });
      const r = await getReport(c, reportId);
      await appendAssistantMessage(c, {
        conversationId: r.conversation_id,
        body: await renderTemplate(c, territory.id, "welcome", { territory: territory.name }),
        origin: "template",
      });
      return reportId;
    });
    return Response.json(await getDraftView(pool, id, session.id), { status: 201 });
  });
}
