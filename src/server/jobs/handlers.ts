import { getReport } from "../intake/drafts";
import { evaluateRevision, respondToEvaluation } from "../intake/orchestrator";
import { onProcessReportFailed, processReport } from "../pipeline/process-report";
import { runTextgen } from "../pipeline/textgen";
import { openReviewItem } from "../review/items";
import type { JobKind } from "./queue";
import type { Handler } from "./worker-loop";

export const handlers: Partial<Record<JobKind, Handler>> = {
  /** Evaluación de un borrador que no llegó a tiempo en el chat. Si la revisión cambió, otro turno responde. */
  evaluate_report: {
    async run(deps, job) {
      const r = await getReport(deps.pool, job.entity_id);
      if (r.status !== "draft" || r.revision !== job.entity_revision) return;
      const res = await evaluateRevision(deps, r.id, r.revision);
      if (!res.ok) {
        if (res.error.message === "revisión obsoleta") return;
        throw new Error(`${res.error.kind}: ${res.error.message}`);
      }
      await respondToEvaluation(deps, r.id, r.revision, res.value);
    },
    /** Sin evaluación tras agotar intentos: a revisión. El borrador sigue editable y se puede enviar igual. */
    async onFailed(deps, job, error) {
      await openReviewItem(deps.pool, {
        territoryId: job.territory_id,
        kind: "provider_failure",
        entityType: "report",
        entityId: job.entity_id,
        reasons: [{ code: "provider_failure", stage: "evaluate_report", revision: job.entity_revision, error: error.slice(0, 500) }],
      });
    },
  },
  process_report: { run: processReport, onFailed: onProcessReportFailed },
  /** Textos del operador por revisión del incidente. Nunca bloquea otra etapa: sin LLM, plantilla. */
  textgen: {
    async run(deps, job) {
      const { fallbacks } = await runTextgen(deps, job);
      for (const [purpose, why] of Object.entries(fallbacks)) console.warn(`textgen ${job.entity_id}@${job.entity_revision} ${purpose}: plantilla (${why})`);
    },
  },
};
