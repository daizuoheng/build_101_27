import type { Db } from "../db/pool";

export type JobKind = "evaluate_report" | "process_report" | "assess_incident" | "plan" | "dispatch" | "textgen";

export type Job = {
  id: string;
  kind: JobKind;
  entity_type: string;
  entity_id: string;
  entity_revision: number;
  territory_id: string | null;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
};

export type EnqueueInput = {
  kind: JobKind;
  entityType: string;
  entityId: string;
  entityRevision: number;
  territoryId?: string | null;
  payload?: Record<string, unknown>;
  runAfter?: Date;
  /** Sufijo extra para jobs que se repiten sobre la misma revisión (p. ej. replanificación periódica). */
  dedupeSuffix?: string;
};

/** Idempotente por `kind:entityType:entityId:entityRevision`. */
export async function enqueue(db: Db, j: EnqueueInput): Promise<{ id: string; created: boolean }> {
  const dedupeKey = [j.kind, j.entityType, j.entityId, j.entityRevision, j.dedupeSuffix].filter((x) => x !== undefined).join(":");
  const ins = await db.query<{ id: string }>(
    `insert into jobs (kind, entity_type, entity_id, entity_revision, dedupe_key, territory_id, payload, run_after)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, now()))
     on conflict (dedupe_key) do nothing returning id`,
    [j.kind, j.entityType, j.entityId, j.entityRevision, dedupeKey, j.territoryId ?? null, j.payload ?? {}, j.runAfter ?? null],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, created: true };
  const existing = await db.query<{ id: string }>("select id from jobs where dedupe_key = $1", [dedupeKey]);
  return { id: existing.rows[0].id, created: false };
}

/** Toma un job elegible con lease. `FOR UPDATE SKIP LOCKED` evita que dos workers tomen el mismo. */
export async function claimNext(db: Db, workerId: string, leaseSec: number): Promise<Job | null> {
  const { rows } = await db.query<Job>(
    `update jobs set status = 'running', attempts = attempts + 1, locked_by = $1,
       lease_until = now() + make_interval(secs => $2), updated_at = now()
     where id = (
       select id from jobs
       where (status = 'pending' and run_after <= now()) or (status = 'running' and lease_until < now())
       order by run_after, created_at
       for update skip locked limit 1
     )
     returning id, kind, entity_type, entity_id, entity_revision, territory_id, attempts, max_attempts, payload`,
    [workerId, leaseSec],
  );
  return rows[0] ?? null;
}

export async function renewLease(db: Db, jobId: string, workerId: string, leaseSec: number): Promise<void> {
  await db.query(
    "update jobs set lease_until = now() + make_interval(secs => $3) where id = $1 and locked_by = $2 and status = 'running'",
    [jobId, workerId, leaseSec],
  );
}

export async function completeJob(db: Db, jobId: string): Promise<void> {
  await db.query("update jobs set status = 'done', lease_until = null, last_error = null, updated_at = now() where id = $1", [jobId]);
}

/** Reintento con espera creciente; al agotar intentos queda `failed` y el llamador abre revisión. */
export async function failJob(db: Db, job: Job, error: string, baseBackoffSec = 5): Promise<{ failed: boolean }> {
  const failed = job.attempts >= job.max_attempts;
  await db.query(
    `update jobs set status = $2, last_error = $3, lease_until = null, locked_by = null, updated_at = now(),
       run_after = now() + make_interval(secs => $4)
     where id = $1`,
    [job.id, failed ? "failed" : "pending", error.slice(0, 2000), baseBackoffSec * 2 ** (job.attempts - 1)],
  );
  return { failed };
}
