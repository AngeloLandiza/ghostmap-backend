import { OAuth2Client, type TokenPayload } from 'google-auth-library'
import { googleClientIds } from '../env.js'
import { AppError, notConfigured } from './errors.js'

let client: OAuth2Client | undefined

export const isGoogleSignInConfigured = (): boolean => googleClientIds().length > 0

export interface GoogleIdentity {
  sub: string
  email: string
  name: string
  pictureUrl: string | null
}

/**
 * Verifies a Google id token against the audiences in `GOOGLE_CLIENT_IDS` (web + iOS client ids).
 * Accounts whose email Google has not verified are rejected.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  const audience = googleClientIds()
  if (audience.length === 0) throw notConfigured('Google sign-in (GOOGLE_CLIENT_IDS)')
  if (!client) client = new OAuth2Client()
  let payload: TokenPayload | undefined
  try {
    const ticket = await client.verifyIdToken({ idToken, audience })
    payload = ticket.getPayload()
  } catch {
    throw new AppError('unauthorized', 'google id_token could not be verified')
  }
  if (!payload?.sub) throw new AppError('unauthorized', 'google id_token has no subject')
  if (!payload.email || payload.email_verified !== true) throw new AppError('unauthorized', 'google account email is not verified')
  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name?.trim() || payload.email,
    pictureUrl: payload.picture ?? null,
  }
}
