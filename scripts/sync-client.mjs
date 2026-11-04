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
  "  'plugins.hint': ['在这里安装和管理引擎 profile 的插件。安装、卸载与启停写入引擎的独立 profile，改动在重启引擎后生效。', \"Install and manage the engine profile's plugins here. Installs, uninstalls, and enablement go to the engine's own profile and apply after an engine restart.\"],",
  "  'plugins.intro': ['安装、启用和配置引擎插件', 'Install, enable, and configure engine plugins'],",
  "  'plugins.refresh': ['刷新', 'Refresh'],",
  "  'plugins.addPlugin': ['添加插件', 'Add plugin'],",
  "  'plugins.installedGroup': ['已安装插件', 'Installed plugins'],",
  "  'plugins.empty': ['还没有安装任何插件。', 'No plugins installed yet.'],",
  "  'plugins.protected': ['引擎核心', 'engine core'],",
  "  'plugins.protectedReason': ['引擎自身依赖，不能停用或卸载', 'The engine depends on it; it cannot be disabled or uninstalled'],",
  "  'plugins.notBundle': ['未声明 dsh.bundle，仅作为依赖安装', 'declares no dsh.bundle — installed as a plain dependency'],",
  "  'plugins.dependencyTag': ['依赖', 'dependency'],",
  "  'plugins.enableToggle': ['启用 {name}', 'Enable {name}'],",
  "  'plugins.uninstall': ['卸载', 'Uninstall'],",
  "  'plugins.uninstallTitle': ['卸载「{name}」？', 'Uninstall \"{name}\"?'],",
  "  'plugins.uninstallDescription': ['卸载后它提供的功能会消失，重启引擎后生效。', 'Its features disappear; the change applies when the engine restarts.'],",
  "  'plugins.installTitle': ['添加插件', 'Add plugin'],",
  "  'plugins.installDescription': ['输入插件的包名、Git 仓库地址或本地目录路径。', \"Enter the plugin's package name, Git repository, or local directory path.\"],",
  "  'plugins.installSpecLabel': ['包名或地址', 'Package or address'],",
  "  'plugins.installSpecPlaceholder': ['例如 dsh-plugin-whale-pet', 'e.g. dsh-plugin-whale-pet'],",
  "  'plugins.registryTitle': ['安装源', 'Registry'],",
  "  'plugins.registryDefault': ['默认安装源', 'Default registry'],",
  "  'plugins.registryOfficial': ['npm 官方源', 'npm official registry'],",
  "  'plugins.registryNpmmirror': ['中国大陆镜像源', 'China mirror registry'],",
  "  'plugins.registryCustom': ['自定义地址', 'Custom URL'],",
  "  'plugins.registryCustomPlaceholder': ['https://npm.example.com/', 'https://npm.example.com/'],",
  "  'plugins.registryCustomHint': ['自定义源需要登录时，把凭据放在本机的 ~/.npmrc 里。', 'For a registry that requires login, keep its credentials in the local ~/.npmrc.'],",
  "  'plugins.registryCustomInvalid': ['请输入以 http:// 或 https:// 开头的地址', 'Enter an address starting with http:// or https://'],",
  "  'plugins.installGuideToggle': ['插件安装引导和示例', 'Install guide and examples'],",
  "  'plugins.installGuideHide': ['收起引导', 'Hide guide'],",
  "  'plugins.installGuideNpm': ['npm 包名：插件包名即 npm 包名（如 dsh-xxx 或 @作者/插件名）。', 'npm package: the plugin name is its npm name (dsh-xxx or @author/plugin).'],",
  "  'plugins.installGuideGit': ['Git 仓库：github:owner/repo、git URL 或 .git 地址。', 'Git repository: github:owner/repo, a git URL, or a .git address.'],",
  "  'plugins.installGuidePath': ['本地目录：本机插件 checkout 的绝对路径（以 link 方式安装）。', 'Local directory: an absolute path to a local checkout (installed as a link).'],",
  "  'plugins.fill': ['填入', 'Fill in'],",
  "  'plugins.fillExample': ['填入示例 {example}', 'Fill in the example {example}'],",
  "  'plugins.installGuideSafety': ['请确认插件来源可信。插件以你的权限在本机运行，来源不明的插件可能损坏引擎，或读取和泄露你的数据。', 'Only add plugins you trust. Plugins run locally with your permissions; untrusted plugins can damage the engine or read and leak your data.'],",
  "  'plugins.installRun': ['安装', 'Install'],",
  "  'plugins.installingTitle': ['插件安装中…', 'Installing plugin…'],",
  "  'plugins.installBackground': ['可以关闭此窗口，安装会在后台继续；进度显示在列表上方的横幅里。', 'You can close this dialog; the install continues in the background and its progress shows in the banner above the list.'],",
  "  'plugins.installDoneRestart': ['已安装，请重启引擎加载它。', 'Installed. Restart the engine to load it.'],",
  "  'plugins.installFailedTitle': ['插件安装失败', 'Plugin install failed'],",
  "  'plugins.installDetailsShow': ['查看安装详情', 'Show install details'],",
  "  'plugins.installDetailsHide': ['收起安装详情', 'Hide install details'],",
  "  'plugins.installRetry': ['重试', 'Retry'],",
  "  'plugins.installClose': ['完成', 'Done'],",
  "  'plugins.failure.network': ['网络连接失败，请检查网络或代理后重试', 'Network failed; check connectivity or proxy, then retry'],",
  "  'plugins.failure.notFound': ['未找到相关插件', 'Plugin not found'],",
  "  'plugins.failure.version': ['没有匹配的版本', 'No matching version'],",
  "  'plugins.failure.disk': ['磁盘空间不足，安装已停止', 'Disk full; the install stopped'],",
  "  'plugins.failure.permission': ['没有写入权限，无法安装', 'No write permission; the install failed'],",
  "  'plugins.failure.build': ['有依赖的安装脚本被 pnpm 拦下：在引擎 profile 的 pnpm-workspace.yaml 的 allowBuilds 中放行后重试', \"A dependency build script was blocked by pnpm: allow it under allowBuilds in the engine profile's pnpm-workspace.yaml, then retry\"],",
  "  'plugins.failure.integrity': ['下载的安装包校验失败', 'The downloaded package failed integrity checks'],",
  "  'plugins.failure.timeout': ['安装超时', 'The install timed out'],",
  "  'plugins.failure.generic': ['安装过程中出错，原因见安装详情', 'The install failed; see the details'],",
  "  'plugins.restartNotice': ['请重启引擎使更改生效。这个 profile 只在启动时应用更改。', 'Restart the engine to apply the change; this profile applies changes at startup only.'],",
  "  'plugins.restart': ['重启引擎', 'Restart engine'],",
  "  'plugins.restarting': ['正在重启…', 'Restarting…'],",
  "  'plugins.opInstallRunning': ['正在安装 {target}…', 'Installing {target}…'],",
  "  'plugins.opUninstallRunning': ['正在卸载 {target}…', 'Uninstalling {target}…'],",
  "  'plugins.opFailed': ['上次操作失败：{error}', 'The last operation failed: {error}'],",
]

patchFile('client/locales.ts', [
  ["  'tab.execution': ['执行', 'Execution'],",
   "  'tab.execution': ['执行', 'Execution'],\n  'tab.plugins': ['插件', 'Plugins'],"],
  ["  'healthCode.pollFailures': ['连续 {count} 次轮询失败，最近一次：{error}', HEALTH_TEXT.pollFailures],",
   "  'healthCode.pollFailures': ['连续 {count} 次轮询失败，最近一次：{error}', HEALTH_TEXT.pollFailures],\n  // Plugins tab (dsh-superagent-console seam; see scripts/sync-client.mjs)\n" + PLUGINS_LOCALE_KEYS.join('\n')],
])

/**
 * Seam patches for the Settings → Models group (src/client/models-page.tsx):
 * the settings sub-menu list, the SettingsPage group switch, and the
 * settingsGroup/providerSync dictionaries. Same anchor discipline as above.
 */
patchFile('client/route.ts', [
  // The Models group joins the settings sub-menu, after Deployment.
  ["export const SETTINGS_GROUPS = ['source', 'eval', 'execution', 'prompts', 'deployment'] as const",
   "export const SETTINGS_GROUPS = ['source', 'eval', 'execution', 'prompts', 'deployment', 'models'] as const"],
])

patchFile('client/settings.tsx', [
  // Our group page, imported across the vendor boundary.
  ["import { SourceSettings } from './source.tsx'",
   "import { ModelsPage } from '../../client/models-page.tsx'\nimport { SourceSettings } from './source.tsx'"],
  ["      case 'deployment': return <DeploymentPage setup={state.setup} form={deploymentForm} />",
   "      case 'deployment': return <DeploymentPage setup={state.setup} form={deploymentForm} />\n      case 'models': return <ModelsPage />"],
])

const MODELS_LOCALE_KEYS = [
  "  'providerSync.title': ['供应商同步', 'Provider sync'],",
  "  'providerSync.hint': ['把本端（安装该插件的端）当前生效的模型供应商同步到引擎 profile；写入走备份 + 原子写，明文密钥不复制。', \"Carry this host's live model providers into the engine profile; writes are backed up, atomic, and never copy plaintext secrets.\"],",
  "  'providerSync.source': ['本端（settings 生效值）', 'This host (live settings)'],",
  "  'providerSync.engine': ['引擎 profile', 'Engine profile'],",
  "  'providerSync.unavailable': ['不可用', 'unavailable'],",
  "  'providerSync.sourceMissing': ['本端供应商不可读：settings 服务未注入或无 llm-pi-ai 条目。', 'Host providers unreadable: settings service not injected or no llm-pi-ai entry.'],",
  "  'providerSync.engineMissing': ['引擎 profile 不可读：{reason}', 'Engine profile unreadable: {reason}'],",
  "  'providerSync.diffTitle': ['与引擎 profile 的差异', 'Differences against the engine profile'],",
  "  'providerSync.added': ['引擎缺少（将补齐）', 'Missing on engine (will append)'],",
  "  'providerSync.changed': ['两侧都有但配置不同', 'Present on both, configured differently'],",
  "  'providerSync.removed': ['仅引擎有', 'Engine only'],",
  "  'providerSync.noDiff': ['引擎 profile 与本端供应商一致，无需同步。', \"The engine profile matches this host's providers — nothing to sync.\"],",
  "  'providerSync.mode': ['同步模式', 'Sync mode'],",
  "  'providerSync.mode.merge': ['增补', 'Merge'],",
  "  'providerSync.mode.mirror': ['镜像', 'Mirror'],",
  "  'providerSync.modeHint': ['增补只把引擎缺少的供应商追加进 profile，已有条目不动；镜像用本端全量替换引擎供应商（排除清单除外），需要重启引擎生效。', \"Merge appends only the providers the engine lacks; mirror replaces the engine providers with this host's set (minus the exclusion list). An engine restart applies the change.\"],",
  "  'providerSync.exclude': ['排除清单：{ids}', 'Excluded: {ids}'],",
  "  'providerSync.do': ['同步到引擎 profile', 'Sync into engine profile'],",
  "  'providerSync.doing': ['同步中…', 'Syncing…'],",
  "  'providerSync.done': ['已写入引擎 profile（{mode}）', 'Written into the engine profile ({mode})'],",
  "  'providerSync.backup': ['备份：{path}', 'Backup: {path}'],",
  "  'providerSync.skipped': ['已跳过：{id} — {reason}', 'Skipped: {id} — {reason}'],",
  "  'providerSync.hotVerified': ['引擎已热加载新供应商，无需重启。', 'The engine hot-reloaded the new providers — no restart needed.'],",
  "  'providerSync.hotOffline': ['引擎未在运行，变更将在下次启动时生效。', 'The engine is not running; the change applies at next start.'],",
  "  'providerSync.hotTimeout': ['引擎未在时限内反映变更，可重启引擎兜底。', 'The engine did not reflect the change in time; restart it as a fallback.'],",
  "  'providerSync.restart': ['重启引擎', 'Restart engine'],",
  "  'providerSync.restarting': ['正在重启…', 'Restarting…'],",
  "  'providerSync.autoOn': ['自动同步已开启（监听宿主 settings 变化）', 'Auto sync enabled (watching host settings)'],",
]

patchFile('client/locales.ts', [
  ["  'settingsGroup.deployment': ['部署', 'Deployment'],",
   "  'settingsGroup.deployment': ['部署', 'Deployment'],\n  'settingsGroup.models': ['模型', 'Models'],"],
  ["  // Plugins tab (dsh-superagent-console seam; see scripts/sync-client.mjs)",
   "  // Provider sync (dsh-superagent-console seam; see scripts/sync-client.mjs)\n" + MODELS_LOCALE_KEYS.join('\n') + "\n  // Plugins tab (dsh-superagent-console seam; see scripts/sync-client.mjs)"],
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
