import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

export type ErrorCode =
  | 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict'
  | 'session_full' | 'session_ended'
  | 'not_configured' | 'upstream_error' | 'internal'

const statusFor: Record<ErrorCode, number> = {
  bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409,
  session_full: 409, session_ended: 410,
  not_configured: 501, upstream_error: 502, internal: 500,
}

/** Typed API error: `{ error: { code, message, details? } }` with a matching HTTP status. */
export class AppError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: unknown) {
    super(message)
  }
  get status(): number { return statusFor[this.code] }
}

export function notFound(what: string): AppError { return new AppError('not_found', `${what} not found`) }
export function forbidden(message = 'forbidden'): AppError { return new AppError('forbidden', message) }
export function badRequest(message: string, details?: unknown): AppError { return new AppError('bad_request', message, details) }
export function notConfigured(what: string): AppError { return new AppError('not_configured', `${what} is not configured on this deployment`) }
export function sessionFull(max: number): AppError { return new AppError('session_full', `the party already has ${max} participants`) }
export function sessionEnded(status: string): AppError { return new AppError('session_ended', `the party is ${status}`) }

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as 400)
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: 'http_error', message: err.message } }, err.status)
  }
  console.error('unhandled error', err)
  return c.json({ error: { code: 'internal', message: 'internal error' } }, 500)
}
