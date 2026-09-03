import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { allowedOrigins } from './env.js'
import { errorHandler } from './lib/errors.js'
import { optionalAuth } from './lib/auth.js'
import { usageRecorder } from './lib/usage.js'
import { admin } from './routes/admin.js'
import { auth } from './routes/auth.js'
import { devices } from './routes/devices.js'
import { health } from './routes/health.js'
import { maps } from './routes/maps.js'
import { markers } from './routes/markers.js'
import { merge } from './routes/merge.js'
import { realtime } from './routes/realtime.js'
import { sessions } from './routes/sessions.js'

export const app = new Hono()

app.onError(errorHandler)
app.notFound((c) => c.json({ error: { code: 'not_found', message: `no route for ${c.req.method} ${new URL(c.req.url).pathname}` } }, 404))

app.use('*', secureHeaders())
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return origin
    const allowed = allowedOrigins()
    if (allowed.includes(origin) || /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i.test(origin)) return origin
    return null
  },
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'X-Api-Key', 'X-Worker-Id'],
  maxAge: 86400,
}))
if (process.env.NODE_ENV !== 'test') app.use('*', logger())
app.use('*', optionalAuth)
app.use('*', usageRecorder)

app.route('/', health)
app.route('/', auth)
app.route('/', devices)
app.route('/', maps)
app.route('/', sessions)
app.route('/', realtime)
app.route('/', markers)
app.route('/', merge)
app.route('/', admin)

app.get('/', (c) => c.json({ service: 'ghostmap-backend', docs: 'https://github.com/AngeloLandiza/ghostmap-backend/blob/main/docs/API.md' }))
