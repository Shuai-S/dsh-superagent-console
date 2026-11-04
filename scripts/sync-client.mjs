/**
 * Vendor the official dsh-superagent client SOURCE tree into src/vendor/,
 * mirroring the prototype's src/ layout so every relative import inside the
 * vendored files keeps resolving. Our own client entry (src/client.tsx) then
 * builds one gated bundle around the official panel components.
 *
 * Why source instead of the compiled lib/client.js: the compiled bundle wraps
 * itself in window.__ModuleLoader__.load(...) and exports only apply/inject,
 * so a wrapper cannot compose its panel components. Building our own bundle
 * needs the source graph.
 *
 * Source resolution order:
 *   1. $SUPERAGENT_SRC (path to the dsh-superagent-prototype checkout)
 *   2. ../dsh-superagent-prototype (sibling checkout)
 *
 * The importer crawls relative imports (from/import/import(), including
 * `?raw` suffixed ones) starting from src/client/** and src/navigation.ts,
 * so new upstream files are picked up automatically on the next sync.
 *
 * After copying, a seam patch wires our Plugins tab (src/client/plugins-page.tsx)
 * into the vendored panel: route type/tab list, the App route switch, and the
 * plugins.* dictionaries. Each patch demands exact upstream anchors — an
 * upstream edit that removes one fails the sync loudly instead of shipping a
 * half-wired tab.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Sibling checkouts, most specific first. Inside a worktree the sibling lives
 * next to the MAIN checkout, so resolve it from the git common dir.
 */
function siblingCandidates() {
  const list = [process.env.SUPERAGENT_SRC].filter(Boolean)
  list.push(resolve(root, '../dsh-superagent-prototype'))
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root }).toString().trim()
    list.push(resolve(dirname(commonDir), '..', 'dsh-superagent-prototype'))
  } catch {
    // Not a git checkout — the first two candidates may still hit.
  }
  return list
}

const prototypeSrc = siblingCandidates().map((p) => join(p, 'src')).find((p) => existsSync(p))
if (!prototypeSrc) {
  console.error('[sync-client] no prototype checkout found; looked at:\n  ' + siblingCandidates().join('\n  '))
  process.exit(1)
}

const destSrc = join(root, 'src', 'vendor')
rmSync(destSrc, { recursive: true, force: true })
mkdirSync(destSrc, { recursive: true })

/** Matches relative import specifiers: `from './x.ts'`, `import './y.css?raw'`, `import('./z.ts')`. */
const IMPORT_RE = /(?:\bfrom\s+|\bimport\s+|\bimport\()\s*['"](\.[^'"]+)['"]/g
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.css', '.json']

const copied = []
const queued = ['client/index.tsx', 'client/app.tsx', 'client/locales.ts', 'client/deployment.tsx', 'client/css.d.ts', 'navigation.ts']
const seen = new Set()

function resolveSpecifier(importerRel, spec) {
  const raw = spec.endsWith('?raw') ? spec.slice(0, -4) : spec
  const base = resolve(join(prototypeSrc, dirname(importerRel)), raw)
  const rel = relative(prototypeSrc, base)
  for (const ext of RESOLVE_EXTS) {
    const candidate = rel + ext
    const absolute = join(prototypeSrc, candidate)
    if (existsSync(absolute) && statSync(absolute).isFile()) return candidate
  }
  return null
}

function vendorFile(rel) {
  if (seen.has(rel)) return
  seen.add(rel)
  const absolute = join(prototypeSrc, rel)
  if (!existsSync(absolute)) {
    console.error(`[sync-client] warning: ${rel} does not exist upstream, skipped`)
    return
  }
  const destination = join(destSrc, rel)
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(absolute, destination)
  copied.push(rel)

  if (!/\.(ts|tsx)$/.test(rel)) return
  const code = readFileSync(absolute, 'utf8')
  for (const match of code.matchAll(IMPORT_RE)) {
    const resolved = resolveSpecifier(rel, match[1])
    if (resolved) queued.push(resolved)
  }
}

while (queued.length > 0) {
  vendorFile(queued.shift())
}

if (!copied.some((rel) => rel === 'client/app.tsx')) {
  console.error('[sync-client] upstream client graph did not resolve; nothing usable vendored')
  process.exit(1)
}

/**
 * Seam patches for the Plugins tab, applied to the fresh vendor copy.
 * Every anchor must match exactly once; a miss means upstream drifted and
 * the sync fails before a half-wired tab can be built.
 */
function patchFile(rel, edits) {
  const file = join(destSrc, rel)
  let text = readFileSync(file, 'utf8')
  for (const [find, replace] of edits) {
    const hits = text.split(find).length - 1
    if (hits !== 1) {
      console.error('[sync-client] patch anchor matched ' + hits + ' times in ' + rel + ' (need exactly 1):\n  ' + find)
      process.exit(1)
    }
    text = text.replace(find, replace)
  }
  writeFileSync(file, text)
  console.log('[sync-client] patched ' + rel + ' (Plugins tab seams)')
}

patchFile('client/route.ts', [
  // Tab bar: plugins sits after settings, matching the console header order.
  ["export const TABS = ['overview', 'source', 'trigger', 'eval', 'execution', 'settings'] as const",
   "export const TABS = ['overview', 'source', 'trigger', 'eval', 'execution', 'settings', 'plugins'] as const"],
  // Route union gains the plugins root (no id, no query).
  ["  | { page: 'settings'; id?: undefined; query: { group: SettingsGroup; source?: string; version?: string } }",
   "  | { page: 'settings'; id?: undefined; query: { group: SettingsGroup; source?: string; version?: string } }\n  | { page: 'plugins'; id?: undefined; query?: undefined }"],
  // parseRoute: the plugins root parses like overview/source.
  ["    case 'overview': case 'source': return { page }",
   "    case 'overview': case 'source': case 'plugins': return { page }"],
])

patchFile('client/app.tsx', [
  // Our page, imported across the vendor boundary into the official panel.
  ["import { Button, Dot, Icon, Input, Modal, SegmentedTabs } from './controls.tsx'",
   "import { PluginsPage } from '../../client/plugins-page.tsx'\nimport { Button, Dot, Icon, Input, Modal, SegmentedTabs } from './controls.tsx'"],
  ["      case 'eval': return <EvalStatus",
   "      case 'plugins': return <PluginsPage />\n      case 'eval': return <EvalStatus"],
])

const PLUGINS_LOCALE_KEYS = [
  "  'plugins.hint': ['管理引擎 profile 的插件依赖。安装、移除与启停写入引擎的独立 profile，重启引擎后生效。', \"Manage the engine profile's plugin dependencies. Installs, removals, and enablement go to the engine's own profile and apply after an engine restart.\"],",
  "  'plugins.installLabel': ['安装插件', 'Install plugin'],",
  "  'plugins.installing': ['正在安装…', 'Installing…'],",
  "  'plugins.specPlaceholder': ['包名 / git URL / github:owner/repo / tarball / 绝对路径', 'package / git URL / github:owner/repo / tarball / absolute path'],",
  "  'plugins.remove': ['移除', 'Remove'],",
  "  'plugins.removeTitle': ['移除插件', 'Remove plugin'],",
  "  'plugins.removeConfirm': ['从引擎 profile 移除 {name}？移除在重启引擎后生效。', 'Remove {name} from the engine profile? It disappears after an engine restart.'],",
  "  'plugins.enable': ['启用', 'Enable'],",
  "  'plugins.disable': ['停用', 'Disable'],",
  "  'plugins.protected': ['引擎核心', 'engine core'],",
  "  'plugins.notBundle': ['未声明 dsh.bundle，仅作为依赖安装', 'declares no dsh.bundle — installed as a plain dependency'],",
  "  'plugins.dependencyTag': ['依赖', 'dependency'],",
  "  'plugins.opInstallRunning': ['正在安装 {target}…', 'Installing {target}…'],",
  "  'plugins.opRemoveRunning': ['正在移除 {target}…', 'Removing {target}…'],",
  "  'plugins.opFailed': ['上次操作失败：{error}', 'Last operation failed: {error}'],",
  "  'plugins.restartHint': ['改动已保存，重启引擎后生效。', 'Saved. Restart the engine to apply.'],",
  "  'plugins.restart': ['重启引擎', 'Restart engine'],",
  "  'plugins.restarting': ['正在重启…', 'Restarting…'],",
  "  'plugins.empty': ['引擎 profile 还没有安装任何插件依赖。', 'No plugin dependencies are installed in the engine profile yet.'],",
]

patchFile('client/locales.ts', [
  ["  'tab.execution': ['执行', 'Execution'],",
   "  'tab.execution': ['执行', 'Execution'],\n  'tab.plugins': ['插件', 'Plugins'],"],
  ["  'healthCode.pollFailures': ['连续 {count} 次轮询失败，最近一次：{error}', HEALTH_TEXT.pollFailures],",
   "  'healthCode.pollFailures': ['连续 {count} 次轮询失败，最近一次：{error}', HEALTH_TEXT.pollFailures],\n  // Plugins tab (dsh-superagent-console seam; see scripts/sync-client.mjs)\n" + PLUGINS_LOCALE_KEYS.join('\n')],
])

/**
 * Service type augmentations for the vendored engine sources. The engine's
 * composition root (app/runtime.ts, intentionally not vendored) loads these
 * package augmentations by importing each service package; our subset reaches
 * their types only indirectly, so this module loads them explicitly and
 * declares the `orchestrator` service the same way runtime.ts does.
 */
const servicesDts = `\
/**
 * Generated by scripts/sync-client.mjs — do not edit; re-run the sync instead.
 * Service type augmentations for the vendored engine sources (see runtime.ts upstream).
 */
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import type { SourceHost } from './sources/host.ts'

declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
`
writeFileSync(join(destSrc, 'services.d.ts'), servicesDts)

console.log(`[sync-client] vendored ${copied.length} files from ${prototypeSrc} -> ${destSrc}`)
for (const rel of copied.sort()) console.log('  ' + rel)
if (readdirSync(destSrc).length === 0) process.exit(1)
