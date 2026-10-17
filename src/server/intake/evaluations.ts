import type { Db } from "../db/pool";
import type { ReportEvaluation } from "@/shared/contracts/evaluation";

export type StoredEvaluation = ReportEvaluation & { id: string; reportRevision: number; policyVersionId: string; catalogHash: string; aiRunId: string };

/** Idempotente por (reporte, revisión): la primera evaluación de una revisión gana. */
export async function saveReportEvaluation(
  db: Db,
  i: { reportId: string; reportRevision: number; aiRunId: string; policyVersionId: string; catalogHash: string; ev: ReportEvaluation; replace?: boolean },
): Promise<void> {
  const e = i.ev;
  // replace: la evaluación previa de esta revisión usó otro catálogo o política; la corrida anterior queda en ai_runs.
  const onConflict = i.replace
    ? `on conflict (report_id, report_revision) do update set ai_run_id = excluded.ai_run_id, policy_version_id = excluded.policy_version_id,
         catalog_hash = excluded.catalog_hash, intent = excluded.intent, applicability = excluded.applicability,
         problem_type_id = excluded.problem_type_id, problem_type_choice = excluded.problem_type_choice, severity = excluded.severity,
         active_fire = excluded.active_fire, passage = excluded.passage, accessibility = excluded.accessibility,
         location_in_text = excluded.location_in_text, photo_quality = excluded.photo_quality, contradiction = excluded.contradiction,
         answers = excluded.answers, needs_review = excluded.needs_review, review_reasons = excluded.review_reasons, created_at = now()`
    : "on conflict (report_id, report_revision) do nothing";
  await db.query(
    `insert into report_evaluations (report_id, report_revision, ai_run_id, policy_version_id, catalog_hash, intent, applicability,
       problem_type_id, problem_type_choice, severity, active_fire, passage, accessibility, location_in_text, photo_quality,
       contradiction, answers, needs_review, review_reasons)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ${onConflict}`,
    [
      i.reportId, i.reportRevision, i.aiRunId, i.policyVersionId, i.catalogHash, e.intent, e.applicability, e.problemTypeId,
      e.problemTypeChoice, e.severity, e.activeFire, e.passage, e.accessibility, e.locationInText, e.photoQuality,
      e.contradiction, JSON.stringify({ ...e.answers, _model: e.model }), e.needsReview, e.reviewReasons,
    ],
  );
}

type Row = {
  id: string; report_revision: number; policy_version_id: string; catalog_hash: string; ai_run_id: string; intent: string;
  applicability: string; problem_type_id: string | null; problem_type_choice: string; severity: string; active_fire: string;
  passage: string; accessibility: string; location_in_text: string; photo_quality: string; contradiction: string;
  answers: Record<string, unknown>; needs_review: boolean; review_reasons: string[];
};

function fromRow(r: Row): StoredEvaluation {
  const { _model, ...answers } = r.answers as Record<string, unknown> & { _model?: string };
  return {
    id: r.id, reportRevision: r.report_revision, policyVersionId: r.policy_version_id, catalogHash: r.catalog_hash, aiRunId: r.ai_run_id,
    intent: r.intent, applicability: r.applicability, problemTypeId: r.problem_type_id, problemTypeChoice: r.problem_type_choice,
    severity: r.severity, activeFire: r.active_fire, passage: r.passage, accessibility: r.accessibility,
    locationInText: r.location_in_text, photoQuality: r.photo_quality, contradiction: r.contradiction,
    answers, needsReview: r.needs_review, reviewReasons: r.review_reasons, model: _model ?? "",
  } as StoredEvaluation;
}

export async function getEvaluation(db: Db, reportId: string, revision: number): Promise<StoredEvaluation | null> {
  const { rows } = await db.query<Row>("select * from report_evaluations where report_id = $1 and report_revision = $2", [reportId, revision]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function getLatestEvaluation(db: Db, reportId: string): Promise<StoredEvaluation | null> {
  const { rows } = await db.query<Row>("select * from report_evaluations where report_id = $1 order by report_revision desc limit 1", [reportId]);
  return rows[0] ? fromRow(rows[0]) : null;
}
