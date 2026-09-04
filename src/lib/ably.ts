import Ably from 'ably'
import { env } from '../env.js'
import { notConfigured } from './errors.js'
import { recordUsageEvent } from './usageEvents.js'

let rest: Ably.Rest | undefined

function client(): Ably.Rest {
  const key = env().ABLY_API_KEY
  if (!key) throw notConfigured('Ably realtime')
  if (!rest) rest = new Ably.Rest({ key })
  return rest
}

export const isAblyConfigured = (): boolean => Boolean(env().ABLY_API_KEY)

export const sessionChannel = (sessionId: string): string => `session:${sessionId}`

/**
 * Ably TokenRequest for a client. Devices get publish/subscribe/presence on their session channel,
 * viewers get subscribe/presence, admins get everything. Clients pass this object to Ably's SDK
 * (`authCallback`) so the API key never ships in an app.
 */
export async function createTokenRequest(opts: { clientId: string; sessionId?: string; publish: boolean; admin?: boolean; ttlSeconds?: number }) {
  const capability: Record<string, string[]> = opts.admin
    ? { '*': ['publish', 'subscribe', 'presence', 'history'] }
    : opts.sessionId
      ? { [sessionChannel(opts.sessionId)]: opts.publish ? ['publish', 'subscribe', 'presence', 'history'] : ['subscribe', 'presence', 'history'] }
      : { 'session:*': ['subscribe', 'history'] }
  recordUsageEvent('ably_token', 1, 0)
  return client().auth.createTokenRequest({
    clientId: opts.clientId,
    capability: JSON.stringify(capability),
    ttl: (opts.ttlSeconds ?? 3600) * 1000,
  })
}

/** Server-side publish (used when keyframes are registered through the API). */
export async function publish(sessionId: string, name: string, data: unknown): Promise<void> {
  // Ably bills the publish plus one delivery per subscriber; the subscriber count is added in costs/usage.ts.
  let bytes = 0
  try { bytes = JSON.stringify(data ?? null).length } catch { bytes = 0 }
  recordUsageEvent('ably_publish', 1, bytes)
  await client().channels.get(sessionChannel(sessionId)).publish(name, data)
}

export async function ablyHealth(): Promise<{ ok: boolean; detail?: string }> {
  try {
    await client().time()
    return { ok: true }
  } catch (e) {
    return { ok: false, detail: String(e) }
  }
}
