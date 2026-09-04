/**
 * PLAN §3 — counters for the things `api_usage` cannot see: signed URLs minted, keyframes registered,
 * Ably publishes and token requests, BigQuery jobs, New Relic pushes and GCS listings.
 *
 * Events are accumulated per request in an `AsyncLocalStorage` batch and written once, after the response,
 * through `waitUntil` so the client never waits for the insert. Nothing here throws: a cost counter must
 * never be the reason an upload fails.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { MiddlewareHandler } from 'hono'
import { waitUntil } from '@vercel/functions'
import { db, schema } from '../db/client.js'

export const USAGE_EVENT_KINDS = [
  'signed_upload', 'signed_download', 'keyframe_registered',
  'ably_publish', 'ably_token', 'bq_query', 'nr_push', 'gcs_list',
] as const

export type UsageEventKind = (typeof USAGE_EVENT_KINDS)[number]

interface Tally { count: number; bytes: number }
type Batch = Map<UsageEventKind, Tally>

const store = new AsyncLocalStorage<Batch>()

function add(batch: Batch, kind: UsageEventKind, count: number, bytes: number): void {
  const t = batch.get(kind) ?? { count: 0, bytes: 0 }
  t.count += count
  t.bytes += bytes
  batch.set(kind, t)
}

/** Writes one row per kind. Errors are logged, never propagated. */
async function flush(batch: Batch): Promise<void> {
  try {
    const values = [...batch.entries()]
      .filter(([, t]) => t.count > 0 || t.bytes > 0)
      .map(([kind, t]) => ({ kind, count: Math.round(t.count), bytes: Math.round(t.bytes) }))
    if (values.length === 0) return
    await db().insert(schema.usageEvents).values(values)
  } catch (e) {
    console.error('usage event insert failed', e)
  }
}

/**
 * Counts one thing that costs money. `count` is the billable quantity (URLs minted, keyframes registered,
 * metrics pushed) and `bytes` the payload size when it is known.
 */
export function recordUsageEvent(kind: UsageEventKind, count = 1, bytes = 0): void {
  try {
    const safeCount = Number.isFinite(count) ? Math.max(0, count) : 0
    const safeBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0
    if (safeCount === 0 && safeBytes === 0) return
    const batch = store.getStore()
    if (batch) {
      add(batch, kind, safeCount, safeBytes)
      return
    }
    // Outside a request (scripts, background helpers): write it straight away, fire and forget.
    const single: Batch = new Map([[kind, { count: safeCount, bytes: safeBytes }]])
    const write = flush(single)
    try { waitUntil(write) } catch { void write }
  } catch (e) {
    console.error('usage event skipped', e)
  }
}

/** Opens a per-request batch and writes it after the response. Mount before the routes. */
export const usageEventRecorder: MiddlewareHandler = async (c, next) => {
  const batch: Batch = new Map()
  try {
    await store.run(batch, next)
  } finally {
    if (batch.size > 0) {
      const write = flush(batch)
      try { waitUntil(write) } catch { void write }
    }
  }
}

/** Test seam: runs `fn` inside a batch and returns what was counted, without touching the database. */
export async function collectUsageEvents<T>(fn: () => Promise<T> | T): Promise<{ result: T; events: Record<string, Tally> }> {
  const batch: Batch = new Map()
  const result = await store.run(batch, async () => fn())
  return { result, events: Object.fromEntries(batch) }
}
