import { handle } from '@hono/node-server/vercel'
import { app } from '../src/app.js'

// Vercel's Node.js runtime calls (req, res); this adapter bridges to app.fetch.
// Body parsing must stay off so Hono/zod read the raw JSON body.
export const config = { api: { bodyParser: false } }

export default handle(app)
