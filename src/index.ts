/**
 * dsh-superagent-console — host half.
 *
 * A thin console for the dsh-superagent engine that keeps running in its own
 * dedicated profile (see the dsh-superagent-prototype checkout). This plugin
 * owns no engine state: it registers one prefix route on the local webServer
 * that proxies `/orchestrator/api` to the engine's Management API, so the
 * vendored panel client works same-origin from the desktop app.
 *
 * The client half (lib/client.js) is the official dsh-superagent panel build,
 * vendored by scripts/sync-client.mjs with the ModuleLoader id rewritten.
 *
 * @module dsh-superagent-console
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { proxyHandler } from './proxy.ts'

export const name: string = 'dsh-superagent-console'

export { Config, type ResolvedConsoleConfig } from './config.ts'

// cordis guards service properties: ctx.webServer access requires declaring
// 'webServer' in inject (activation fails otherwise — verified 2026-11-04).
export const inject: string[] = ['webServer']

export function apply(ctx: Context, config?: { target?: string }): void {
  const target = config?.target ?? 'http://127.0.0.1:3082'
  const webServer = (ctx as { webServer?: {
    host?: string
    register: (route: { kind: 'prefix' | 'exact'; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }) => () => void
  } }).webServer
  if (!webServer?.register) {
    ctx.logger?.warn?.('dsh-superagent-console: no webServer service on this context; console proxy inactive')
    return
  }
  if (webServer.host && webServer.host !== '127.0.0.1' && webServer.host !== 'localhost') {
    ctx.logger?.warn?.('dsh-superagent-console: webServer bound to %s, console proxy only supports loopback', webServer.host)
    return
  }
  const dispose = webServer.register({
    kind: 'prefix',
    path: '/orchestrator/api',
    handler: proxyHandler({ target }) as never,
  })
  ctx.effect(() => dispose)
  ctx.logger?.info?.('dsh-superagent-console: /orchestrator/api -> %s', target)
}

export { proxyHandler } from './proxy.ts'