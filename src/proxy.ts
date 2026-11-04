/**
 * Same-origin proxy for the superagent engine's Management API.
 *
 * The panel client (vendored from dsh-superagent) calls relative
 * `/orchestrator/api/...` with the `x-orchestrator-request: 1` header. This
 * handler forwards the request to the engine's loopback webserver, which
 * enforces host 127.0.0.1:<port> plus that header and no foreign Origin —
 * server-side forwarding satisfies all three.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

export interface ProxyOptions {
  /** Engine base URL, for example http://127.0.0.1:3082 */
  target: string
  /** Upstream timeout in milliseconds. @default 60_000 */
  timeoutMs?: number
  /** Request body cap in bytes. @default 16 MiB */
  maxBodyBytes?: number
}

async function readBody(req: IncomingMessage, cap: number): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > cap) throw new Error('request body too large')
    chunks.push(buf)
  }
  return chunks.length ? Buffer.concat(chunks) : undefined
}

export function proxyHandler(options: ProxyOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { target, timeoutMs = 60_000, maxBodyBytes = 16 * 1024 * 1024 } = options
  const base = target.replace(/\/$/, '')
  return async (req, res) => {
    const incoming = req.url ?? '/'
    const path = incoming.startsWith('/orchestrator/api') ? incoming : '/orchestrator/api/'
    const url = base + path
    try {
      const body = await readBody(req, maxBodyBytes)
      const headers: Record<string, string> = { 'x-orchestrator-request': '1' }
      const contentType = req.headers['content-type']
      if (typeof contentType === 'string') headers['content-type'] = contentType
      if (body !== undefined) headers['content-length'] = String(body.length)
      const upstream = await fetch(url, {
        method: req.method,
        headers,
        body: body as unknown as BodyInit | undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const headersOut: Record<string, string> = {}
      for (const name of ['content-type', 'cache-control']) {
        const value = upstream.headers.get(name)
        if (value) headersOut[name] = value
      }
      res.writeHead(upstream.status, headersOut)
      if (upstream.body) Readable.fromWeb(upstream.body as never).pipe(res)
      else res.end()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const name = (error as { name?: string } | undefined)?.name
      const status = name === 'TimeoutError' ? 504 : 502
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `superagent-console: engine at ${target} unreachable (${message})` }))
      } else {
        res.end()
      }
    }
  }
}
