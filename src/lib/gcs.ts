import { Storage, type Bucket } from '@google-cloud/storage'
import { env, gcpCredentials } from '../env.js'
import { notConfigured } from './errors.js'

let storage: Storage | undefined

export function gcsBucket(): Bucket {
  const e = env()
  if (!e.GCS_BUCKET) throw notConfigured('Google Cloud Storage')
  if (!storage) {
    const credentials = gcpCredentials()
    storage = new Storage(credentials ? { projectId: e.GCP_PROJECT_ID, credentials } : { projectId: e.GCP_PROJECT_ID })
  }
  return storage.bucket(e.GCS_BUCKET)
}

export const isGcsConfigured = (): boolean => Boolean(env().GCS_BUCKET)

/** Files a finished on-device map can contain (mirrors the iOS app's map directory). */
export const MAP_FILES = ['manifest.json', 'keyframes.bin', 'cloud.ply', 'thumbnail.png', 'worldmap.arworldmap', 'session.log'] as const
export type MapFile = (typeof MAP_FILES)[number]

export const mapFileContentType: Record<MapFile, string> = {
  'manifest.json': 'application/json',
  'keyframes.bin': 'application/octet-stream',
  'cloud.ply': 'application/octet-stream',
  'thumbnail.png': 'image/png',
  'worldmap.arworldmap': 'application/octet-stream',
  'session.log': 'text/plain',
}

/** Keyframe blob kinds streamed during a session. */
export const KEYFRAME_KINDS = ['depth', 'confidence', 'jpeg', 'mesh'] as const
export type KeyframeKind = (typeof KEYFRAME_KINDS)[number]

const keyframeExt: Record<KeyframeKind, { ext: string; contentType: string }> = {
  depth: { ext: 'depth.lzfse', contentType: 'application/octet-stream' },
  confidence: { ext: 'conf.lzfse', contentType: 'application/octet-stream' },
  jpeg: { ext: 'jpg', contentType: 'image/jpeg' },
  mesh: { ext: 'mesh.bin', contentType: 'application/octet-stream' },
}

export const mapObjectPath = (mapId: string, file: MapFile): string => `maps/${mapId}/${file}`

export const keyframeObjectPath = (sessionId: string, deviceId: string, seq: number, kind: KeyframeKind): string =>
  `sessions/${sessionId}/kf/${deviceId}/${String(seq).padStart(8, '0')}.${keyframeExt[kind].ext}`

export const keyframeContentType = (kind: KeyframeKind): string => keyframeExt[kind].contentType

export interface SignedUpload {
  path: string
  url: string
  method: 'PUT' | 'POST'
  headers: Record<string, string>
  expires_at: string
  /** For resumable uploads: POST with these headers, then PUT the body to the `Location` returned by GCS. */
  resumable: boolean
}

/** V4 signed URL for a direct-to-GCS upload. Small blobs use a single PUT; large files use a resumable session. */
export async function signUpload(path: string, contentType: string, opts: { resumable?: boolean; ttlSeconds?: number } = {}): Promise<SignedUpload> {
  const ttl = opts.ttlSeconds ?? 15 * 60
  const expires = Date.now() + ttl * 1000
  const file = gcsBucket().file(path)
  if (opts.resumable) {
    const [url] = await file.getSignedUrl({ version: 'v4', action: 'resumable', expires, contentType })
    return { path, url, method: 'POST', headers: { 'Content-Type': contentType, 'x-goog-resumable': 'start' }, expires_at: new Date(expires).toISOString(), resumable: true }
  }
  const [url] = await file.getSignedUrl({ version: 'v4', action: 'write', expires, contentType })
  return { path, url, method: 'PUT', headers: { 'Content-Type': contentType }, expires_at: new Date(expires).toISOString(), resumable: false }
}

/** V4 signed URL for reading an object. */
export async function signDownload(path: string, ttlSeconds = 15 * 60): Promise<{ url: string; expires_at: string }> {
  const expires = Date.now() + ttlSeconds * 1000
  const [url] = await gcsBucket().file(path).getSignedUrl({ version: 'v4', action: 'read', expires })
  return { url, expires_at: new Date(expires).toISOString() }
}

export interface ObjectInfo { path: string; size: number; updated?: string; contentType?: string }

export async function statObject(path: string): Promise<ObjectInfo | undefined> {
  const file = gcsBucket().file(path)
  const [exists] = await file.exists()
  if (!exists) return undefined
  const [meta] = await file.getMetadata()
  return { path, size: Number(meta.size ?? 0), updated: meta.updated, contentType: meta.contentType }
}

export async function listObjects(prefix: string, max = 5000): Promise<ObjectInfo[]> {
  const [files] = await gcsBucket().getFiles({ prefix, maxResults: max })
  return files.map((f) => ({ path: f.name, size: Number(f.metadata.size ?? 0), updated: f.metadata.updated, contentType: f.metadata.contentType }))
}

export async function deletePrefix(prefix: string): Promise<number> {
  const files = await listObjects(prefix)
  await Promise.all(files.map((f) => gcsBucket().file(f.path).delete({ ignoreNotFound: true })))
  return files.length
}

/** Bytes and object counts per top-level prefix (maps/, sessions/), paging through the whole bucket. */
export async function bucketStats(): Promise<{ total_bytes: number; total_objects: number; prefixes: Record<string, { bytes: number; objects: number }> }> {
  const bucket = gcsBucket()
  const prefixes: Record<string, { bytes: number; objects: number }> = {}
  let total_bytes = 0
  let total_objects = 0
  let pageToken: string | undefined
  do {
    const [files, next] = await bucket.getFiles({ maxResults: 1000, pageToken, autoPaginate: false })
    for (const f of files) {
      const size = Number(f.metadata.size ?? 0)
      const top = f.name.split('/')[0] ?? ''
      const p = (prefixes[top] ??= { bytes: 0, objects: 0 })
      p.bytes += size
      p.objects += 1
      total_bytes += size
      total_objects += 1
    }
    pageToken = (next as { pageToken?: string } | null)?.pageToken
  } while (pageToken)
  return { total_bytes, total_objects, prefixes }
}
