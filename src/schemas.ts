import { z } from 'zod'
import { INVITE_CODE_RE, normalizeInviteCode } from './lib/parties.js'

export const uuid = z.string().uuid()

/** An invite code as typed by a human: case and separators are normalised before validation. */
export const inviteCode = z.preprocess(
  (v) => (typeof v === 'string' ? normalizeInviteCode(v) : v),
  z.string().regex(INVITE_CODE_RE, 'invite code must be 8 base32 characters (A-Z, 2-7)'),
)

export const originSchema = z.object({
  type: z.enum(['session-start', 'marker']),
  marker_id: z.string().min(1).optional(),
}).refine((o) => o.type !== 'marker' || Boolean(o.marker_id), { message: 'marker origin requires marker_id' })

const deviceIdentity = z.object({
  id: uuid,
  name: z.string().max(80).default(''),
  platform: z.enum(['ios', 'ipados', 'web', 'worker', 'other']).default('ios'),
})

export const tokenRequest = z.object({
  access_key: z.string().min(8),
  device: deviceIdentity.optional(),
})

/** Google sign-in: an id token from Google Identity Services (web) or the iOS PKCE flow. */
export const googleSignIn = z.object({
  id_token: z.string().min(20),
  device: deviceIdentity.optional(),
})

export const createMap = z.object({
  name: z.string().min(1).max(120),
  frame: z.string().default('world:session-start'),
  origin: originSchema.default({ type: 'session-start' }),
  session_id: uuid.optional(),
  parent_map_id: uuid.optional(),
  files: z.array(z.enum(['manifest.json', 'keyframes.bin', 'cloud.ply', 'thumbnail.png', 'worldmap.arworldmap', 'session.log']))
    .default(['manifest.json', 'keyframes.bin', 'cloud.ply', 'thumbnail.png', 'session.log']),
})

export const uploadUrls = z.object({
  files: z.array(z.enum(['manifest.json', 'keyframes.bin', 'cloud.ply', 'thumbnail.png', 'worldmap.arworldmap', 'session.log'])).min(1).max(6),
})

export const finalizeMap = z.object({
  manifest: z.record(z.unknown()).optional(),
})

export const patchMap = z.object({ name: z.string().min(1).max(120) })

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().datetime().optional(),
  status: z.string().optional(),
  session_id: uuid.optional(),
})

export const createSession = z.object({
  name: z.string().min(1).max(120),
  origin: originSchema.default({ type: 'session-start' }),
  base_map_id: uuid.optional(),
  max_participants: z.coerce.number().int().min(1).max(8).default(4),
})

export const joinSession = z.object({
  code: inviteCode,
  kind: z.enum(['device', 'viewer']).optional(),
  display_name: z.string().max(80).optional(),
})

/** Body for the by-id join route; `kind` follows the token when omitted. */
export const joinSessionById = z.object({
  kind: z.enum(['device', 'viewer']).optional(),
  display_name: z.string().max(80).optional(),
})

export const keyframeUploadUrls = z.object({
  items: z.array(z.object({
    seq: z.number().int().min(0),
    kinds: z.array(z.enum(['depth', 'confidence', 'jpeg', 'mesh'])).min(1),
  })).min(1).max(100),
})

const pose16 = z.array(z.number()).length(16)

export const keyframeIn = z.object({
  seq: z.number().int().min(0),
  t: z.number(),
  pose: pose16,
  intrinsics: z.object({ fx: z.number(), fy: z.number(), cx: z.number(), cy: z.number(), w: z.number().int(), h: z.number().int() }),
  tracking_state: z.enum(['normal', 'limited', 'relocalizing', 'not_available']).default('normal'),
  world_mapping_status: z.string().default('unknown'),
  /** False while the device has not yet seen the marker, so the pose is not in the session origin frame. */
  aligned: z.boolean().default(true),
  depth_ref: z.string().optional(),
  confidence_ref: z.string().optional(),
  jpeg_ref: z.string().optional(),
  mesh_ref: z.string().optional(),
  /** Flat xyz(rgb) floats for the live view; ≤ 2 000 points so the realtime message stays small. */
  points_inline: z.array(z.number()).max(2000 * 6).optional(),
  bytes: z.number().int().min(0).default(0),
})

export const registerKeyframes = z.object({ keyframes: z.array(keyframeIn).min(1).max(50) })

export const keyframeQuery = z.object({
  device_id: uuid.optional(),
  since_id: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  urls: z.coerce.boolean().default(false),
})

export const realtimeToken = z.object({ session_id: uuid.optional() })

export const createMarker = z.object({
  id: z.string().min(1).max(64),
  family: z.string().default('tag36h11'),
  size_m: z.number().positive().default(0.2),
  description: z.string().max(200).default(''),
})

export const completeMergeJob = z.object({
  output_map_id: uuid.optional(),
  error: z.string().max(2000).optional(),
})

export const windowQuery = z.object({ hours: z.coerce.number().int().min(1).max(24 * 30).default(24) })
export const daysQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) })
export const pricingQuery = z.object({ service: z.enum(['storage', 'run', 'bigquery']).default('storage'), region: z.string().optional() })
