import { pgTable, uuid, text, integer, bigint, boolean, real, doublePrecision, jsonb, timestamp, bigserial, unique } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  googleSub: text('google_sub').notNull(),
  email: text('email').notNull().default(''),
  name: text('name').notNull().default(''),
  pictureUrl: text('picture_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }).notNull().defaultNow(),
})

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id'),
  name: text('name').notNull().default(''),
  platform: text('platform').notNull().default('ios'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
})

export const markers = pgTable('markers', {
  id: text('id').primaryKey(),
  family: text('family').notNull().default('tag36h11'),
  sizeM: real('size_m').notNull().default(0.2),
  description: text('description').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const maps = pgTable('maps', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
  parentMapId: uuid('parent_map_id'),
  sessionId: uuid('session_id'),
  deviceId: uuid('device_id'),
  ownerUserId: uuid('owner_user_id'),
  frame: text('frame').notNull().default('world:session-start'),
  origin: jsonb('origin').notNull().$type<Record<string, unknown>>().default({ type: 'session-start' }),
  status: text('status').notNull().default('uploading'),
  manifest: jsonb('manifest').$type<Record<string, unknown> | null>(),
  pointCount: bigint('point_count', { mode: 'number' }).notNull().default(0),
  keyframeCount: integer('keyframe_count').notNull().default(0),
  bbox: jsonb('bbox').$type<Record<string, unknown> | null>(),
  durationS: real('duration_s').notNull().default(0),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
  files: jsonb('files').notNull().$type<string[]>().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
})

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  origin: jsonb('origin').notNull().$type<Record<string, unknown>>().default({ type: 'session-start' }),
  leaderDeviceId: uuid('leader_device_id'),
  ownerUserId: uuid('owner_user_id'),
  inviteCode: text('invite_code'),
  maxParticipants: integer('max_participants').notNull().default(4),
  baseMapId: uuid('base_map_id'),
  mergedMapId: uuid('merged_map_id'),
  keyframeCount: integer('keyframe_count').notNull().default(0),
  bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
})

/** One row per identity in a session. Viewers have no `device_id`; legacy device rows have no `user_id`. */
export const sessionParticipants = pgTable('session_participants', {
  id: uuid('id').primaryKey(),
  sessionId: uuid('session_id').notNull(),
  deviceId: uuid('device_id'),
  userId: uuid('user_id'),
  kind: text('kind').notNull().default('device'),
  color: text('color'),
  displayName: text('display_name'),
  role: text('role').notNull().default('member'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  leftAt: timestamp('left_at', { withTimezone: true }),
})

export const keyframes = pgTable('keyframes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sessionId: uuid('session_id').notNull(),
  deviceId: uuid('device_id').notNull(),
  seq: integer('seq').notNull(),
  t: doublePrecision('t').notNull(),
  pose: real('pose').array().notNull(),
  intrinsics: jsonb('intrinsics').notNull().$type<Record<string, unknown>>(),
  trackingState: text('tracking_state').notNull().default('normal'),
  worldMappingStatus: text('world_mapping_status').notNull().default('unknown'),
  aligned: boolean('aligned').notNull().default(true),
  depthRef: text('depth_ref'),
  confidenceRef: text('confidence_ref'),
  jpegRef: text('jpeg_ref'),
  meshRef: text('mesh_ref'),
  pointsInline: jsonb('points_inline').$type<number[] | null>(),
  bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uniq: unique().on(t.sessionId, t.deviceId, t.seq) }))

export const mergeJobs = pgTable('merge_jobs', {
  id: uuid('id').primaryKey(),
  sessionId: uuid('session_id').notNull(),
  status: text('status').notNull().default('queued'),
  requestedBy: uuid('requested_by'),
  inputMapIds: jsonb('input_map_ids').notNull().$type<string[]>().default([]),
  outputMapId: uuid('output_map_id'),
  error: text('error'),
  cloudRunExecution: text('cloud_run_execution'),
  worker: text('worker'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
})

export const apiUsage = pgTable('api_usage', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  method: text('method').notNull(),
  route: text('route').notNull(),
  status: integer('status').notNull(),
  durationMs: integer('duration_ms').notNull(),
  bytesIn: integer('bytes_in').notNull().default(0),
  bytesOut: integer('bytes_out').notNull().default(0),
  region: text('region'),
  country: text('country'),
  role: text('role'),
  deviceId: uuid('device_id'),
})

export const statsCache = pgTable('stats_cache', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull().$type<unknown>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** PLAN §3: counters for the billable things `api_usage` cannot see (signed URLs, publishes, BigQuery jobs). */
export const usageEvents = pgTable('usage_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  kind: text('kind').notNull(),
  count: integer('count').notNull().default(0),
  bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
})
