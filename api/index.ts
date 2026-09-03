import type { IncomingMessage, ServerResponse } from 'node:http'
import { app } from '../src/app.js'

// Vercel's Node.js runtime calls (req, res) and may have consumed and parsed the request body already
// (req.body). This handler rebuilds a Web-standard Request from either the parsed body or the raw stream,
// hands it to Hono, and writes the Response back — no dependency on body-parser configuration.

type VercelRequest = IncomingMessage & { body?: unknown }

async function readBody(req: VercelRequest): Promise<Buffer | undefined> {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body
    if (typeof req.body === 'string') return Buffer.from(req.body)
    return Buffer.from(JSON.stringify(req.body))
  }
  if (req.complete || req.readableEnded) return undefined
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export default async function handler(req: VercelRequest, res: ServerResponse): Promise<void> {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https'
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost'
  const method = req.method ?? 'GET'
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v))
    else if (typeof value === 'string') headers.set(key, value)
  }
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)
  if (body !== undefined) {
    headers.delete('content-length')
    headers.set('x-request-bytes', String(body.length))
  }
  const request = new Request(`${proto}://${host}${req.url ?? '/'}`, { method, headers, body: body ? new Uint8Array(body) : undefined })
  const response = await app.fetch(request)
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    if (key === 'set-cookie' || key === 'content-encoding') return
    res.setHeader(key, value)
  })
  const cookies = response.headers.getSetCookie()
  if (cookies.length > 0) res.setHeader('set-cookie', cookies)
  res.end(Buffer.from(await response.arrayBuffer()))
}
