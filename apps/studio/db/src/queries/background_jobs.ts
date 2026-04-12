import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../client.ts'
import { background_jobs } from '../schema/background_jobs.ts'
import type { BackgroundJobRow, NewBackgroundJobRow } from '../schema/background_jobs.ts'

export type EnqueueJobParams = {
  type: string
  project_id?: string | null
  idempotency_key?: string | null
  payload: unknown
  scheduled_at?: Date
  max_attempts?: number
}

/**
 * Insert a pending job. ON CONFLICT by idempotency_key → no-op, returns null.
 * NON-BLOCKING contract: callers must NOT await handler execution, only this insert.
 */
export async function enqueueJob(params: EnqueueJobParams): Promise<BackgroundJobRow | null> {
  const values: NewBackgroundJobRow = {
    type: params.type,
    project_id: params.project_id ?? null,
    idempotency_key: params.idempotency_key ?? null,
    payload: params.payload as NewBackgroundJobRow['payload'],
    scheduled_at: params.scheduled_at ?? new Date(),
    max_attempts: params.max_attempts ?? 3,
  }

  if (values.idempotency_key) {
    const [row] = await db
      .insert(background_jobs)
      .values(values)
      .onConflictDoNothing({ target: background_jobs.idempotency_key })
      .returning()
    return row ?? null
  }

  const [row] = await db.insert(background_jobs).values(values).returning()
  return row ?? null
}

/**
 * Atomic job pickup using SELECT ... FOR UPDATE SKIP LOCKED.
 * Returns the claimed job (status='running', attempts++) or null.
 */
export async function claimNextJob(types?: string[]): Promise<BackgroundJobRow | null> {
  const typeFilter = types && types.length > 0
    ? sql`AND "type" IN (${sql.join(types.map(t => sql`${t}`), sql`, `)})`
    : sql``

  const result = await db.execute(sql`
    UPDATE "background_jobs"
    SET "status" = 'running',
        "started_at" = now(),
        "attempts" = "attempts" + 1
    WHERE "id" = (
      SELECT "id" FROM "background_jobs"
      WHERE "status" = 'pending'
        AND "scheduled_at" <= now()
        ${typeFilter}
      ORDER BY "scheduled_at" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `)
  const rows = (result as unknown as { rows?: BackgroundJobRow[] }).rows ?? (result as unknown as BackgroundJobRow[])
  return (Array.isArray(rows) ? rows[0] : null) ?? null
}

export async function markJobCompleted(id: string): Promise<void> {
  await db
    .update(background_jobs)
    .set({ status: 'completed', completed_at: new Date() })
    .where(eq(background_jobs.id, id))
}

export async function markJobFailed(id: string, error: string, terminal: boolean): Promise<void> {
  await db
    .update(background_jobs)
    .set({
      status: terminal ? 'failed' : 'pending',
      error,
      // On retry, delay next attempt by 30s (exponential-ish backoff could come later)
      scheduled_at: terminal ? undefined : new Date(Date.now() + 30_000),
    })
    .where(eq(background_jobs.id, id))
}

export async function listJobs(params: {
  project_id?: string
  type?: string
  status?: string
  limit?: number
}): Promise<BackgroundJobRow[]> {
  const conds = []
  if (params.project_id) conds.push(eq(background_jobs.project_id, params.project_id))
  if (params.type) conds.push(eq(background_jobs.type, params.type))
  if (params.status) conds.push(eq(background_jobs.status, params.status))
  const q = db
    .select()
    .from(background_jobs)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(background_jobs.created_at))
  return q.limit(params.limit ?? 50)
}

export async function getJobById(id: string): Promise<BackgroundJobRow | null> {
  const [row] = await db.select().from(background_jobs).where(eq(background_jobs.id, id))
  return row ?? null
}

export async function cancelJob(id: string): Promise<void> {
  await db
    .update(background_jobs)
    .set({ status: 'cancelled', completed_at: new Date() })
    .where(and(eq(background_jobs.id, id), eq(background_jobs.status, 'pending')))
}
