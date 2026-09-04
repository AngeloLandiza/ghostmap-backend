/**
 * Shared plumbing for the E2E suite (PLAN §6). Every helper here talks to a live deployment over
 * plain HTTP — never to the database or GCS SDKs directly — so this suite exercises exactly what a
 * real client (iOS app, dashboard, worker) would do.
 *
 * The whole suite is opt-in: it is only enabled when all three secrets below are set, and every spec
 * file wraps its `describe` block in `describe.skipIf(!E2E_ENABLED)` so `npm test` (and CI's unit job)
 * never need them and nothing here is ever reported as a *failure* for their absence.
 */

export const E2E_BASE_URL = process.env.E2E_BASE_URL
export const E2E_ADMIN_API_KEY = process.env.E2E_ADMIN_API_KEY
export const E2E_CLIENT_ACCESS_KEY = process.env.E2E_CLIENT_ACCESS_KEY

export const E2E_ENABLED = Boolean(E2E_BASE_URL && E2E_ADMIN_API_KEY && E2E_CLIENT_ACCESS_KEY)

function baseUrl(): string {
  if (!E2E_BASE_URL) throw new Error('E2E_BASE_URL is not set')
  return E2E_BASE_URL.replace(/\/+$/, '')
}

export interface ApiResult<T = any> {
  status: number
  body: T
  headers: Headers
}

/** JSON fetch against the live deployment. Never throws on a non-2xx status — tests assert on `status`. */
export async function api<T = any>(path: string, init: RequestInit & { token?: string } = {}): Promise<ApiResult<T>> {
  const { token, headers, ...rest } = init
  const h = new Headers(headers)
  if (token) h.set('Authorization', `Bearer ${token}`)
  if (rest.body !== undefined && !h.has('Content-Type')) h.set('Content-Type', 'application/json')
  const res = await fetch(`${baseUrl()}${path}`, { ...rest, headers: h })
  const text = await res.text()
  let body: unknown
  if (text) {
    try { body = JSON.parse(text) } catch { body = text }
  }
  return { status: res.status, body: body as T, headers: res.headers }
}

export const get = <T = any>(path: string, token?: string) => api<T>(path, { method: 'GET', token })

export const post = <T = any>(path: string, json: unknown, token?: string) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(json ?? {}), token })

export const patch = <T = any>(path: string, json: unknown, token?: string) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(json ?? {}), token })

export const del = <T = any>(path: string, token?: string) => api<T>(path, { method: 'DELETE', token })

/** A fresh synthetic device identity: random uuid, e2e-tagged name so it is obvious in `/admin/sessions`. */
export function syntheticDevice(label: string): { id: string; name: string; platform: 'ios' } {
  return { id: crypto.randomUUID(), name: `e2e-${label}-${Date.now()}`, platform: 'ios' }
}

export interface MintedDevice { token: string; device_id: string; name: string }

/** Exchanges the client access key for a device token (PLAN §6: "5 synthetic devices"). */
export async function mintDeviceToken(label: string): Promise<MintedDevice> {
  if (!E2E_CLIENT_ACCESS_KEY) throw new Error('E2E_CLIENT_ACCESS_KEY is not set')
  const device = syntheticDevice(label)
    const res = await post<any>('/v1/auth/token', { access_key: E2E_CLIENT_ACCESS_KEY, device })
  if (res.status !== 200 || !res.body?.token) {
    throw new Error(`could not mint a device token for "${label}": ${res.status} ${JSON.stringify(res.body)}`)
  }
  return { token: res.body.token as string, device_id: res.body.device_id as string, name: device.name }
}

export function adminToken(): string {
  if (!E2E_ADMIN_API_KEY) throw new Error('E2E_ADMIN_API_KEY is not set')
  return E2E_ADMIN_API_KEY
}

/** Cleanup registry: every test that creates a durable row registers how to remove it — LIFO, best-effort. */
type Cleanup = () => Promise<void>
const cleanups: Cleanup[] = []

export function registerCleanup(fn: Cleanup): void {
  cleanups.push(fn)
}

/** Runs and drains every registered cleanup, most-recent first, swallowing individual failures. */
export async function runCleanups(): Promise<void> {
  while (cleanups.length) {
    const fn = cleanups.pop()
    if (!fn) continue
    try { await fn() } catch (e) { console.error('e2e cleanup failed', e) }
  }
}

/** A tiny but well-formed ASCII PLY point cloud — enough for `POST /v1/maps/:id/finalize` to accept `cloud.ply`. */
export function tinyPly(): Uint8Array {
  const text = [
    'ply',
    'format ascii 1.0',
    'element vertex 1',
    'property float x',
    'property float y',
    'property float z',
    'end_header',
    '0 0 0',
    '',
  ].join('\n')
  return new TextEncoder().encode(text)
}

export interface UploadTarget {
  path: string
  url: string
  method: 'PUT' | 'POST'
  headers: Record<string, string>
  resumable: boolean
}

/**
 * Uploads bytes through one signed URL minted by `POST /v1/maps` or `/upload-urls`, following the GCS
 * resumable dance (POST to start a session, then PUT the bytes to the returned `Location`) when the
 * server marked the target resumable — exactly what a real client does for `cloud.ply` / `keyframes.bin`.
 */
export async function uploadTo(upload: UploadTarget, bytes: Uint8Array): Promise<void> {
  const contentType = upload.headers['Content-Type'] ?? upload.headers['content-type'] ?? 'application/octet-stream'
  // TS's DOM lib types `BodyInit` more narrowly than the fetch spec allows; a `Uint8Array` is a valid
  // request body at runtime (Node's undici accepts it directly), so the cast below is purely cosmetic.
  const body = bytes as unknown as BodyInit
  if (!upload.resumable) {
    const res = await fetch(upload.url, { method: 'PUT', headers: { ...upload.headers, 'Content-Length': String(bytes.length) }, body })
    if (!res.ok) throw new Error(`signed PUT failed: ${res.status} ${await res.text().catch(() => '')}`)
    return
  }
  const init = await fetch(upload.url, { method: 'POST', headers: upload.headers })
  if (!init.ok) throw new Error(`resumable session init failed: ${init.status} ${await init.text().catch(() => '')}`)
  const location = init.headers.get('Location')
  if (!location) throw new Error('resumable session init did not return a Location header')
  const put = await fetch(location, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.length), 'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}` },
    body,
  })
  if (!put.ok) throw new Error(`resumable PUT failed: ${put.status} ${await put.text().catch(() => '')}`)
}
