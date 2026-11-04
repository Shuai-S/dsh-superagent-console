/**
 * Vendor the official dsh-superagent panel client build into lib/client.js,
 * rewriting the ModuleLoader registration id to this plugin's name.
 *
 * Source resolution order:
 *   1. $SUPERAGENT_CLIENT (explicit path to a built client.js)
 *   2. ../dsh-superagent-prototype/lib/client.js (sibling checkout)
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const candidates = [
  process.env.SUPERAGENT_CLIENT,
  resolve(root, '../dsh-superagent-prototype/lib/client.js'),
].filter(Boolean)

const source = candidates.find((p) => existsSync(p))
if (!source) {
  console.error('[sync-client] no built client found; looked at:\n  ' + candidates.join('\n  '))
  console.error('[sync-client] run "pnpm build" in the dsh-superagent-prototype checkout first')
  process.exit(1)
}

const outDir = join(root, 'lib')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'client.js')

const code = readFileSync(source, 'utf8')
const rewritten = code.replace('id: "dsh-superagent"', 'id: "dsh-superagent-console"')
if (rewritten === code) {
  console.error('[sync-client] warning: banner id "dsh-superagent" not found in source; copied verbatim')
}
writeFileSync(outFile, rewritten)
if (existsSync(source + '.map')) copyFileSync(source + '.map', outFile + '.map')
console.log('[sync-client] vendored', source, '->', outFile)
