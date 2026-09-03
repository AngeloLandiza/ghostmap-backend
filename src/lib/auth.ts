import type { Context, MiddlewareHandler } from 'hono'
import { SignJWT, jwtVerify } from 'jose'
import { env, clientAccessKeys } from '../env.js'
import { AppError } from './errors.js'

export type Role = 'admin' | 'worker' | 'client' | 'device'

export interface Principal {
  role: Role
  /** Present for role `device`. */
  deviceId?: string
  /** How the principal authenticated. */
  via: 'jwt' | 'api_key' | 'cron'
}

declare module 'hono' {
  interface ContextVariableMap {
    principal: Principal
  }
}

const secret = () => new TextEncoder().encode(env().AUTH_JWT_SECRET)

export interface TokenClaims { role: Role; device_id?: string }

/** Mints an HS256 JWT. Device tokens live 30 days, client tokens 7 days, admin tokens 1 day. */
export async function mintToken(claims: TokenClaims): Promise<{ token: string; expiresAt: string }> {
  const ttlSeconds = claims.role === 'device' ? 30 * 86400 : claims.role === 'client' ? 7 * 86400 : 86400
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const token = await new SignJWT({ role: claims.role, device_id: claims.device_id })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('ghostmap-backend')
    .setExpirationTime(exp)
    .sign(secret())
  return { token, expiresAt: new Date(exp * 1000).toISOString() }
}

export async function verifyToken(token: string): Promise<Principal> {
  const { payload } = await jwtVerify(token, secret(), { issuer: 'ghostmap-backend' })
  const role = payload.role as Role
  if (!['admin', 'worker', 'client', 'device'].includes(role)) throw new AppError('unauthorized', 'invalid token role')
  return { role, deviceId: typeof payload.device_id === 'string' ? payload.device_id : undefined, via: 'jwt' }
}

/** Resolves a raw access key (as pasted into a client) to a role, or undefined. */
export function roleForAccessKey(key: string): Role | undefined {
  const e = env()
  if (key === e.ADMIN_API_KEY) return 'admin'
  if (e.WORKER_API_KEY && key === e.WORKER_API_KEY) return 'worker'
  if (clientAccessKeys().includes(key)) return 'client'
  return undefined
}

async function resolvePrincipal(c: Context): Promise<Principal | undefined> {
  const header = c.req.header('authorization') ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : undefined
  const raw = bearer ?? c.req.header('x-api-key')
  if (!raw) return undefined
  const e = env()
  if (e.CRON_SECRET && raw === e.CRON_SECRET) return { role: 'admin', via: 'cron' }
  const keyRole = roleForAccessKey(raw)
  if (keyRole === 'admin' || keyRole === 'worker') return { role: keyRole, via: 'api_key' }
  if (raw.split('.').length === 3) {
    try { return await verifyToken(raw) } catch { throw new AppError('unauthorized', 'invalid or expired token') }
  }
  return undefined
}

/** Requires an authenticated principal with one of the given roles (admin always passes). */
export function requireAuth(...roles: Role[]): MiddlewareHandler {
  return async (c, next) => {
    const p = await resolvePrincipal(c)
    if (!p) throw new AppError('unauthorized', 'missing or invalid credentials')
    if (p.role !== 'admin' && roles.length > 0 && !roles.includes(p.role)) {
      throw new AppError('forbidden', `requires role ${roles.join(' or ')}`)
    }
    c.set('principal', p)
    await next()
  }
}

/** Attaches a principal when credentials are present, without requiring them. */
export const optionalAuth: MiddlewareHandler = async (c, next) => {
  const p = await resolvePrincipal(c).catch(() => undefined)
  if (p) c.set('principal', p)
  await next()
}

export const isAdmin = (p: Principal): boolean => p.role === 'admin'
