import type { IntakeDeps } from "../intake/orchestrator";
import { claimNext, completeJob, failJob, renewLease, type Job, type JobKind } from "./queue";

export type Handler = {
  run: (deps: IntakeDeps, job: Job) => Promise<void>;
  /** Se llama una vez cuando el job agota sus intentos. */
  onFailed?: (deps: IntakeDeps, job: Job, error: string) => Promise<void>;
};

export type WorkerOptions = {
  workerId: string;
  leaseSec?: number;
  idleMs?: number;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  /** Tarea que `runWorker` corre al arrancar y después cada `everyMs` (entre jobs). Si falla, se loguea y el loop sigue. */
  periodic?: { everyMs: number; run: () => Promise<void> };
};

/** Procesa un job si hay uno elegible. Devuelve false si la cola estaba vacía. */
export async function runOnce(deps: IntakeDeps, handlers: Partial<Record<JobKind, Handler>>, opts: WorkerOptions): Promise<boolean> {
  const leaseSec = opts.leaseSec ?? 60;
  const job = await claimNext(deps.pool, opts.workerId, leaseSec);
  if (!job) return false;
  const log = opts.log ?? (() => {});
  const handler = handlers[job.kind];
  const t0 = Date.now();

  // Retomado tras vencer el lease (el worker anterior murió sin cerrar) y ya sin intentos: no se corre de nuevo.
  if (job.attempts > job.max_attempts) {
    const msg = "el worker se interrumpió en todos los intentos (lease vencido)";
    const { applied } = await failJob(deps.pool, { ...job, attempts: job.max_attempts }, opts.workerId, msg);
    log(`✗ ${job.kind} ${job.entity_id}@${job.entity_revision}: ${msg}`);
    if (applied && handler?.onFailed) await handler.onFailed(deps, job, msg).catch((e) => log(`onFailed: ${e}`));
    return true;
  }

  const heartbeat = setInterval(() => renewLease(deps.pool, job.id, opts.workerId, leaseSec).catch(() => {}), (leaseSec * 1000) / 3);
  try {
    if (!handler) throw new Error(`sin handler para ${job.kind}`);
    await handler.run(deps, job);
    const done = await completeJob(deps.pool, job.id, opts.workerId);
    log(`${done ? "✓" : "⚠ lease perdido, otro worker lo retomó:"} ${job.kind} ${job.entity_id}@${job.entity_revision} ${Date.now() - t0}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const { failed, applied } = await failJob(deps.pool, job, opts.workerId, msg);
    log(`✗ ${job.kind} ${job.entity_id}@${job.entity_revision} intento ${job.attempts}/${job.max_attempts}: ${msg}${applied ? "" : " (lease perdido)"}`);
    if (failed && applied && handler?.onFailed) await handler.onFailed(deps, job, msg).catch((e) => log(`onFailed: ${e}`));
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

export async function runWorker(deps: IntakeDeps, handlers: Partial<Record<JobKind, Handler>>, opts: WorkerOptions): Promise<void> {
  const idleMs = opts.idleMs ?? 1000;
  let lastTick = -Infinity;
  while (!opts.signal?.aborted) {
    if (opts.periodic && Date.now() - lastTick >= opts.periodic.everyMs) {
      lastTick = Date.now();
      try {
        await opts.periodic.run();
      } catch (err) {
        opts.log?.(`tarea periódica: ${err instanceof Error ? err.message : err}`);
      }
    }
    let worked = false;
    try {
      worked = await runOnce(deps, handlers, opts);
    } catch (err) {
      opts.log?.(`error del loop: ${err instanceof Error ? err.message : err}`);
    }
    if (!worked) await new Promise((r) => setTimeout(r, idleMs));
  }
}
