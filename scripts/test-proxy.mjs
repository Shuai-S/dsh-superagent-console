/**
 * Standalone proxy verification: starts a throwaway server on 3088 using the
 * built proxyHandler and issues real requests against the live engine.
 * Usage: node scripts/test-proxy.mjs   (engine must be running on 3082)
 */
import { createServer } from 'node:http'
import { proxyHandler } from '../lib/index.js'

const handler = proxyHandler({ target: process.env.SA_TARGET ?? 'http://127.0.0.1:3082' })
const server = createServer((req, res) => { void handler(req, res) })
await new Promise((resolve) => server.listen(3088, '127.0.0.1', resolve))
console.log('[test-proxy] listening on 127.0.0.1:3088')

const base = 'http://127.0.0.1:3088'
async function probe(path, init) {
  const res = await fetch(base + path, init)
  const text = await res.text()
  console.log('GET', path, '->', res.status, res.headers.get('content-type'), '|', text.slice(0, 160).replace(/\n/g, ' '))
  return res.status
}
const ok = await probe('/orchestrator/api/state')
await probe('/orchestrator/api/settings')
await probe('/orchestrator/api/sources')
server.close()
process.exit(ok === 200 ? 0 : 1)
