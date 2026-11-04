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
 *                              the guarded online installer, and engine
 *                              start/restart via the lifecycle script
 *
 * The client half (lib/client.js) is our gated build around the official
 * dsh-superagent panel sources vendored by scripts/sync-client.mjs.
 *
 * @module dsh-superagent-console
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { expandHome, type ResolvedConsoleConfig } from './config.ts'
import { consoleApiHandler } from './console-api.ts'
import { proxyHandler } from './proxy.ts'

export const name: string = 'dsh-superagent-console'

export { Config, type ResolvedConsoleConfig } from './config.ts'
export { detect, type ConsoleState, type DetectResult, type Prereq } from './detect.ts'
export { engineAction, readSetupState, runInstall, type SetupState, type StageId } from './installer.ts'

const DEFAULTS: ResolvedConsoleConfig = {
  target: 'http://127.0.0.1:3082',
  repoUrl: 'git@github.com:deepseek-ai/dsh-superagent-prototype.git',
  engineDir: '~/.dsh/state/superagent-console/engine',
  profileName: 'superagent',
  extraPath: '~/.local/bin:/usr/local/bin:/opt/homebrew/bin',
}

interface WebServerLike {
  host?: string
  register: (route: { kind: 'prefix' | 'exact'; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }) => () => void
}

// cordis guards service properties: ctx.webServer access requires declaring
// 'webServer' in inject (activation fails otherwise — verified 2026-11-04).
export const inject: string[] = ['webServer']

export function apply(ctx: Context, config?: Partial<ResolvedConsoleConfig>): void {
  const resolved: ResolvedConsoleConfig = {
    target: config?.target ?? DEFAULTS.target,
    repoUrl: config?.repoUrl ?? DEFAULTS.repoUrl,
    engineDir: expandHome(config?.engineDir ?? DEFAULTS.engineDir),
    profileName: config?.profileName ?? DEFAULTS.profileName,
    extraPath: expandHome(config?.extraPath ?? DEFAULTS.extraPath),
  }
  const env = { extraPath: resolved.extraPath }
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
    handler: consoleApiHandler({ config: resolved, env }) as never,
  })
  ctx.effect(() => disposeApi)
  ctx.logger?.info?.(
    'dsh-superagent-console: /orchestrator/api -> %s; console api mounted (profile %s, engine dir %s)',
    resolved.target,
    resolved.profileName,
    resolved.engineDir,
  )
}

export { proxyHandler } from './proxy.ts'
