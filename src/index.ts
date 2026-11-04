/**
 * dsh-superagent-console — host half.
 *
 * A thin console for the dsh-superagent engine that keeps running in its own
 * dedicated profile (see the dsh-superagent-prototype checkout). This plugin
 * owns no engine state. It registers two prefix routes on the local webServer:
 *
 *   /orchestrator/api        → same-origin proxy to the engine Management API
 *                              (the vendored panel client talks to this)
 *   /superagent-console/api  → console control API: layered engine detection,
 *                              the guarded online installer, engine
 *                              start/restart via the lifecycle script, and
 *                              the guarded model-provider sync
 *
 * The settings service is injected optionally (ctx.inject): when the host
 * provides one, the provider-sync API reads live llm-pi-ai providers through
 * it and, with autoSync enabled, keeps the engine profile patch in step.
 *
 * The client half (lib/client.js) is our gated build around the official
 * dsh-superagent panel sources vendored by scripts/sync-client.mjs.
 *
 * @module dsh-superagent-console
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { expandHome, type ResolvedConsoleConfig } from './config.ts'
import { consoleApiHandler, runProviderSync, providerSyncBusy } from './console-api.ts'
import { proxyHandler } from './proxy.ts'
import { diffProviders, enginePatchPath, readEngineProviders, readHostProviders, type SettingsFace } from './provider-sync.ts'
import { engineAction, type InstallEnv } from './installer.ts'
import { probeEngine } from './detect.ts'

export const name: string = 'dsh-superagent-console'

export { Config, type ResolvedConsoleConfig, type SyncMode } from './config.ts'
export { detect, type ConsoleState, type DetectResult, type Prereq } from './detect.ts'
export { engineAction, readSetupState, runInstall, type SetupState, type StageId } from './installer.ts'
export {
  applyProviderSync,
  diffProviders,
  readEngineProviders,
  readHostProviders,
  type ProviderDiff,
  type SettingsFace,
  type SyncReport,
} from './provider-sync.ts'

const DEFAULTS: ResolvedConsoleConfig = {
  target: 'http://127.0.0.1:3082',
  repoUrl: 'git@github.com:deepseek-ai/dsh-superagent-prototype.git',
  engineDir: '~/.dsh/state/superagent-console/engine',
  profileName: 'superagent',
  extraPath: '~/.local/bin:/usr/local/bin:/opt/homebrew/bin',
  syncMode: 'merge',
  syncExclude: [],
  autoSync: false,
  autoRestart: false,
}

interface WebServerLike {
  host?: string
  register: (route: { kind: 'prefix' | 'exact'; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }) => () => void
}

// cordis guards service properties: ctx.webServer access requires declaring
// 'webServer' in inject (activation fails otherwise — verified 2026-11-04).
// 'settings' stays OUT of this list on purpose: hosts without it would fail
// activation wholesale. It joins optionally via ctx.inject below.
export const inject: string[] = ['webServer']

/**
 * Periodic auto-sync watcher (stage 3): poll the host settings and the engine
 * patch, and when the relevant diff is non-empty run one guarded sync.
 * merge mode only reacts to providers the engine lacks; mirror reacts to any
 * divergence. autoRestart then restarts a running engine so the new providers
 * land in its model catalog. Off entirely unless autoSync is configured.
 */
function startAutoSync(ctx: Context, resolved: ResolvedConsoleConfig, env: InstallEnv, getSettings: () => SettingsFace | null): () => void {
  if (!resolved.autoSync) return () => undefined
  let lastSignature = ''
  const tick = async (): Promise<void> => {
    if (providerSyncBusy()) return
    const face = getSettings()
    if (!face) return
    const host = readHostProviders(face)
    if (!host.available || !host.providers) return
    const engine = readEngineProviders(enginePatchPath(resolved))
    if (!engine.available || !engine.providers) return
    const diff = diffProviders(host.providers, engine.providers)
    const signature = JSON.stringify(resolved.syncMode === 'mirror'
      ? [diff.added, diff.changed, diff.removed]
      : [diff.added])
    if (signature === '[[],[],[]]' || signature === '[[]]' || signature === lastSignature) return
    lastSignature = signature
    try {
      const report = await runProviderSync(resolved, face)
      ctx.logger?.info?.(
        'dsh-superagent-console: auto provider sync (%s) added %j removed %j, backup %s',
        report.mode, report.added, report.removed, report.backupPath,
      )
      if (resolved.autoRestart && report.needsRestart && (await probeEngine(resolved.target))) {
        const result = await engineAction(resolved, 'restart', env)
        ctx.logger?.info?.('dsh-superagent-console: auto restart after provider sync, exit %s', result.exit)
      }
    } catch (error) {
      ctx.logger?.warn?.('dsh-superagent-console: auto provider sync failed: %s', error instanceof Error ? error.message : String(error))
    }
  }
  const timer = setInterval(() => { void tick() }, 30_000)
  void tick()
  return () => clearInterval(timer)
}

export function apply(ctx: Context, config?: Partial<ResolvedConsoleConfig>): void {
  const resolved: ResolvedConsoleConfig = {
    target: config?.target ?? DEFAULTS.target,
    repoUrl: config?.repoUrl ?? DEFAULTS.repoUrl,
    engineDir: expandHome(config?.engineDir ?? DEFAULTS.engineDir),
    profileName: config?.profileName ?? DEFAULTS.profileName,
    extraPath: expandHome(config?.extraPath ?? DEFAULTS.extraPath),
    syncMode: config?.syncMode ?? DEFAULTS.syncMode,
    syncExclude: config?.syncExclude ?? DEFAULTS.syncExclude,
    autoSync: config?.autoSync ?? DEFAULTS.autoSync,
    autoRestart: config?.autoRestart ?? DEFAULTS.autoRestart,
  }
  const env = { extraPath: resolved.extraPath }
  // Filled in once the optional settings service resolves; the console API
  // reports provider sync as unavailable until then.
  let settingsFace: SettingsFace | null = null
  const webServer = (ctx as { webServer?: WebServerLike }).webServer
  if (!webServer?.register) {
    ctx.logger?.warn?.('dsh-superagent-console: no webServer service on this context; console proxy inactive')
    return
  }
  if (webServer.host && webServer.host !== '127.0.0.1' && webServer.host !== 'localhost') {
    ctx.logger?.warn?.('dsh-superagent-console: webServer bound to %s, console routes only support loopback', webServer.host)
    return
  }
  const disposeProxy = webServer.register({
    kind: 'prefix',
    path: '/orchestrator/api',
    handler: proxyHandler({ target: resolved.target }) as never,
  })
  ctx.effect(() => disposeProxy)
  const disposeApi = webServer.register({
    kind: 'prefix',
    path: '/superagent-console/api',
    handler: consoleApiHandler({ config: resolved, env, settings: () => settingsFace }) as never,
  })
  ctx.effect(() => disposeApi)
  ctx.logger?.info?.(
    'dsh-superagent-console: /orchestrator/api -> %s; console api mounted (profile %s, engine dir %s)',
    resolved.target,
    resolved.profileName,
    resolved.engineDir,
  )

  // Optional settings service: powers the provider-sync source. Inert on hosts
  // without one; a top-level 'settings' in `inject` would break those hosts.
  ctx.inject(['settings'], (scope) => {
    const face = (scope as unknown as { settings?: SettingsFace }).settings
    if (!face || typeof face.describe !== 'function') {
      ctx.logger?.warn?.('dsh-superagent-console: settings service present but unusable; provider sync reads stay unavailable')
      return
    }
    settingsFace = face
    ctx.effect(() => startAutoSync(ctx, resolved, env, () => settingsFace), 'dsh-superagent-console: provider auto-sync watcher')
    ctx.logger?.info?.('dsh-superagent-console: provider sync source attached (autoSync %s, mode %s)', resolved.autoSync ? 'on' : 'off', resolved.syncMode)
  })
}

export { proxyHandler } from './proxy.ts'
