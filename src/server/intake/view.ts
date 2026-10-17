import type { Db } from "../db/pool";
import { notFound } from "../errors";
import { getOwnedReport } from "./drafts";
import { getEvaluation, getLatestEvaluation } from "./evaluations";
import { indicatesActiveHazard } from "./branches";
import { statusLabel } from "./status";
import type { DraftView, MessageView, TerritoryView } from "@/shared/contracts/intake";

export async function getTerritoryView(db: Db, by: { slug?: string; id?: string }): Promise<TerritoryView & { id: string }> {
  const { rows } = await db.query<{ id: string; slug: string; name: string; area_label: string; lon: number; lat: number; default_zoom: number; emergency_channel: { text?: string } }>(
    `select id, slug, name, area_label, st_x(center::geometry) as lon, st_y(center::geometry) as lat, default_zoom, emergency_channel
     from territories where enabled and (slug = $1 or id::text = $2)`,
    [by.slug ?? null, by.id ?? null],
  );
  const t = rows[0];
  if (!t) throw notFound("Territorio no habilitado.");
  return {
    id: t.id, slug: t.slug, name: t.name, areaLabel: t.area_label, center: { lon: t.lon, lat: t.lat }, zoom: t.default_zoom,
    emergencyText: t.emergency_channel?.text ?? null,
  };
}

/** Vista del borrador/reporte para su dueño. Todo sale de la base: el estado nunca lo inventa un modelo. */
export async function getDraftView(db: Db, reportId: string, sessionId: string): Promise<DraftView> {
  const r = await getOwnedReport(db, reportId, sessionId);
  const territory = await getTerritoryView(db, { id: r.territory_id! });
  const territoryView = { ...territory, id: undefined };

  const msgs = await db.query<{ id: string; seq: number; role: MessageView["role"]; body: string; origin: MessageView["origin"]; created_at: Date; ui: MessageView["ui"]; attachment_id: string | null }>(
    `select m.id, m.seq, m.role, m.body, m.origin, m.created_at, m.ui,
       (select a.id from attachments a where a.message_id = m.id and a.purpose = 'original' limit 1) as attachment_id
     from messages m where m.conversation_id = $1 order by m.seq`,
    [r.conversation_id],
  );
  const area = r.area_id ? (await db.query<{ name: string }>("select name from areas where id = $1", [r.area_id])).rows[0]?.name ?? null : null;
  const photos = (await db.query<{ n: number }>("select count(*)::int as n from attachments where report_id = $1 and purpose = 'original'", [r.id])).rows[0].n;

  const current = await getEvaluation(db, r.id, r.revision);
  const latest = current ?? (await getLatestEvaluation(db, r.id));
  const typeName = latest?.problemTypeId
    ? (await db.query<{ name: string }>("select name from problem_types where id = $1", [latest.problemTypeId])).rows[0]?.name ?? null
    : null;
  const missing: DraftView["card"]["missing"] = [];
  if (!r.description?.trim()) missing.push("description");
  if (!r.location_confirmed) missing.push("location");
  if (!current) missing.push("evaluation");
  // Sin evaluación vigente (Jev falló o tarda) se permite enviar igual: el worker evalúa después.
  const isReport = !current || current.intent === "report" || current.applicability !== "unrelated";

  const pendingJob = await db.query(
    "select 1 from jobs where kind = 'evaluate_report' and entity_id = $1 and entity_revision = $2 and status in ('pending', 'running')",
    [r.id, r.revision],
  );

  let tracking: DraftView["tracking"] = null;
  if (r.status === "confirmed") {
    const inc = await db.query<{ status: NonNullable<DraftView["tracking"]>["incidentStatus"]; priority_band: NonNullable<DraftView["tracking"]>["priorityBand"] }>(
      `select i.status, i.priority_band from report_incident_links l join incidents i on i.id = l.incident_id where l.report_id = $1 and l.active`,
      [r.id],
    );
    const i = inc.rows[0];
    tracking = {
      processing: r.processing,
      outcome: r.outcome,
      incidentStatus: i?.status ?? null,
      priorityBand: i?.priority_band ?? null,
      statusLabel: statusLabel(r.processing, r.outcome, i?.status ?? null),
    };
  }

  return {
    id: r.id,
    status: r.status,
    revision: r.revision,
    publicCode: r.public_code,
    territory: territoryView,
    messages: msgs.rows.map((m) => ({
      id: m.id, seq: m.seq, role: m.role, body: m.body, origin: m.origin, createdAt: m.created_at.toISOString(), ui: m.ui ?? null, attachmentId: m.attachment_id,
    })),
    location: r.lon !== null && r.lat !== null
      ? { lon: r.lon, lat: r.lat, text: r.location_text, source: r.location_source, confirmed: r.location_confirmed, areaName: area }
      : null,
    card: {
      typeName,
      description: r.description?.trim() || null,
      severity: (latest?.severity as DraftView["card"]["severity"]) ?? null,
      place: r.location_text,
      areaName: area,
      photoCount: photos,
      activeHazard: latest ? indicatesActiveHazard(latest) : false,
      needsReview: latest?.needsReview ?? false,
      ready: r.status === "draft" && isReport && r.location_confirmed && !!r.description?.trim(),
      missing,
    },
    analysisPending: r.status === "draft" && !!pendingJob.rows[0],
    tracking,
  };
}

export async function listMyReports(db: Db, sessionId: string, territoryId: string) {
  const { rows } = await db.query<{ id: string; status: "draft" | "confirmed"; public_code: string | null; created_at: Date; description: string | null }>(
    `select id, status, public_code, created_at, description from reports
     where citizen_session_id = $1 and territory_id = $2 order by created_at desc limit 20`,
    [sessionId, territoryId],
  );
  return rows.map((r) => ({
    id: r.id, status: r.status, publicCode: r.public_code, createdAt: r.created_at.toISOString(),
    preview: r.description ? r.description.slice(0, 80) : null,
  }));
}
