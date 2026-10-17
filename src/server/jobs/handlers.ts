import { getReport } from "../intake/drafts";
import { evaluateRevision, respondToEvaluation } from "../intake/orchestrator";
import { onProcessReportFailed, processReport } from "../pipeline/process-report";
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
  },
  process_report: { run: processReport, onFailed: onProcessReportFailed },
};
