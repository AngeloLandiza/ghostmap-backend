import { randomBytes } from 'node:crypto'

/**
 * Pure party logic: invite codes, the colour palette and the participant cap.
 * Nothing here touches the database, so it is unit-testable on its own.
 */

/** RFC 4648 base32, uppercase, no padding. 256 % 32 === 0, so masking a random byte is unbiased. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const INVITE_CODE_LENGTH = 8
export const INVITE_CODE_RE = /^[A-Z2-7]{8}$/

/** A fresh invite code: 8 uppercase base32 characters from crypto-grade randomness. */
export function generateInviteCode(length: number = INVITE_CODE_LENGTH): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += BASE32[(bytes[i] ?? 0) & 31]
  return out
}

/** Uppercases and strips spaces/dashes so `abcd-2345` and `ABCD2345` are the same code. */
export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, '')
}

export function isInviteCode(raw: string): boolean {
  return INVITE_CODE_RE.test(raw)
}

export function shareUrl(dashboardOrigin: string, code: string): string {
  return `${dashboardOrigin.replace(/\/+$/, '')}/join/${code}`
}

/** Eight colours handed out in join order; a participant keeps its colour across rejoins. */
export const PARTICIPANT_COLORS = [
  '#38bdf8', '#f472b6', '#facc15', '#4ade80', '#a78bfa', '#fb923c', '#22d3ee', '#f87171',
] as const

/** The first palette colour nobody in the session holds yet (wrapping once all eight are taken). */
export function pickColor(taken: readonly (string | null | undefined)[]): string {
  const used = new Set(taken.filter((c): c is string => typeof c === 'string' && c.length > 0).map((c) => c.toLowerCase()))
  const free = PARTICIPANT_COLORS.find((c) => !used.has(c))
  return free ?? PARTICIPANT_COLORS[used.size % PARTICIPANT_COLORS.length] ?? PARTICIPANT_COLORS[0]
}

export type ParticipantKind = 'device' | 'viewer'

export interface ParticipantLike {
  userId?: string | null
  deviceId?: string | null
  leftAt?: Date | string | null
  color?: string | null
}

export interface Identity {
  userId?: string | null
  deviceId?: string | null
}

/**
 * The key the cap counts. A signed-in account counts once however many devices it brings;
 * a legacy device with no account counts on its own.
 */
export function identityKey(id: Identity): string | undefined {
  if (id.userId) return `user:${id.userId}`
  if (id.deviceId) return `device:${id.deviceId}`
  return undefined
}

/** Distinct identities currently in the session (rows with `left_at IS NULL`). */
export function activeIdentities(rows: readonly ParticipantLike[]): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    if (r.leftAt) continue
    const key = identityKey(r)
    if (key) out.add(key)
  }
  return out
}

export type JoinRejection = 'session_full' | 'session_ended'

export interface JoinDecision {
  ok: boolean
  reason?: JoinRejection
  /** Identities already in the session, so callers can report `participant_count`. */
  activeCount: number
  /** True when this identity is already active — a rejoin, which is always allowed. */
  rejoin: boolean
}

/** Whether `identity` may join: ended sessions are closed, and the cap counts distinct active identities. */
export function joinDecision(opts: {
  status: string
  maxParticipants: number
  participants: readonly ParticipantLike[]
  identity: Identity
}): JoinDecision {
  const active = activeIdentities(opts.participants)
  const key = identityKey(opts.identity)
  const rejoin = key !== undefined && active.has(key)
  const base = { activeCount: active.size, rejoin }
  if (opts.status !== 'active') return { ok: false, reason: 'session_ended', ...base }
  if (rejoin) return { ok: true, ...base }
  if (active.size >= Math.max(1, opts.maxParticipants)) return { ok: false, reason: 'session_full', ...base }
  return { ok: true, ...base }
}

/** The row belonging to an identity: a device's own row, or the account's viewer row (no device). */
export function matchParticipant<T extends ParticipantLike>(rows: readonly T[], target: Identity): T | undefined {
  if (target.deviceId) return rows.find((r) => r.deviceId === target.deviceId)
  if (target.userId) return rows.find((r) => !r.deviceId && r.userId === target.userId)
  return undefined
}
