import type { Principal } from './auth.js'

/**
 * Ownership and visibility rules (PLAN §1). Pure predicates so they can be unit-tested without a
 * database; the routes translate the same rules into SQL for list endpoints.
 *
 * Rows created before accounts existed carry neither `owner_user_id` nor `device_id`; they stay
 * readable and writable by any authenticated principal so the legacy clients keep working.
 */

export interface MapOwnership {
  ownerUserId: string | null
  deviceId: string | null
  sessionId: string | null
}

export interface SessionOwnership {
  ownerUserId: string | null
  leaderDeviceId: string | null
}

/** The legacy read-only web key sees everything; it is an operator credential, not an account. */
export const isReadEverything = (p: Principal): boolean => p.role === 'admin' || p.role === 'client'

export function ownsMap(p: Principal, m: MapOwnership): boolean {
  if (p.role === 'admin') return true
  if (m.ownerUserId) return Boolean(p.userId) && p.userId === m.ownerUserId
  if (m.deviceId) return Boolean(p.deviceId) && p.deviceId === m.deviceId
  return true
}

/** Reads: own maps, maps produced by a session the principal takes (or took) part in. */
export function canReadMap(p: Principal, m: MapOwnership, participantSessionIds: readonly string[]): boolean {
  if (isReadEverything(p)) return true
  if (ownsMap(p, m)) return true
  return Boolean(m.sessionId) && participantSessionIds.includes(m.sessionId as string)
}

/** Writes require ownership; the legacy `client` role is read-only. */
export function canWriteMap(p: Principal, m: MapOwnership): boolean {
  if (p.role === 'admin') return true
  if (p.role !== 'device' && p.role !== 'user') return false
  return ownsMap(p, m)
}

export function ownsSession(p: Principal, s: SessionOwnership): boolean {
  if (p.role === 'admin') return true
  if (s.ownerUserId && p.userId && s.ownerUserId === p.userId) return true
  if (s.leaderDeviceId && p.deviceId && s.leaderDeviceId === p.deviceId) return true
  return false
}

export function canReadSession(p: Principal, s: SessionOwnership, isParticipant: boolean): boolean {
  if (isReadEverything(p)) return true
  return isParticipant || ownsSession(p, s)
}

/** Ending a party is reserved for its owner account, its leader device and admins. */
export const canEndSession = (p: Principal, s: SessionOwnership): boolean => ownsSession(p, s)
