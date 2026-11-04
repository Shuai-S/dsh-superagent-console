/**
 * Console's own control API, mounted at the `/superagent-console/api` prefix —
 * deliberately separate from the engine proxy at `/orchestrator/api`.
 *
 *   GET  /superagent-console/api/status           layered detection result
 *   GET  /superagent-console/api/setup            persisted install pipeline state
 *   POST /superagent-console/api/install          start the online installer (409 when busy)
 *   POST /superagent-console/api/install/reset    clear stage state for a clean re-run
 *   POST /superagent-console/api/engine/start     lifecycle script start
 *   POST /superagent-console/api/engine/restart   lifecycle script restart
 *   GET  /superagent-console/api/providers        host/engine provider maps + diff + sync state
 *   POST /superagent-console/api/providers/sync   guarded provider sync into the engine patch (409 when busy)
 *
 * Engine plugin management (see plugins.ts — the engine profile's plugin
 * dependencies, driven through `dsh plugin --profile <name>`):
 *
 *   GET  /superagent-console/api/plugins            roster + last operation
 *   GET  /superagent-console/api/plugins/operation  operation state only
 *   POST /superagent-console/api/plugins/install    { spec } — 202, async
 *   POST /superagent-console/api/plugins/remove     { name } — 202, async
 *   POST /superagent-console/api/plugins/enable     { name, enabled } — 200, sync
 *
 * The handler only executes fixed command templates; no request data ever
 * reaches an argv slot. Install state is served from setup.json so the card
 * can poll progress across desktop restarts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ResolvedConsoleConfig, SyncMode } from './config.ts'
import { detect, type DetectResult } from './detect.ts'
import {
  PluginRequestError,
  pluginBusy,
  pluginOperation,
  pluginsState,
  runPluginOperation,
  setBundleEnabled,
} from './plugins.ts'
import {
  engineAction,
  installBusy,
  readSetupState,
  resetInstallState,
  runInstall,
  type EngineActionResult,
  type InstallEnv,
  type SetupState,
} from './installer.ts'
import {
  applyProviderSync,
  diffProviders,
  enginePatchPath,
  readEngineProviders,
  readHostProviders,
  summarizeProvider,
  type ProviderDiff,
  type SettingsFace,
  type SyncReport,
} from './provider-sync.ts'

export interface ConsoleApiOptions {
  config: ResolvedConsoleConfig
  env: InstallEnv
  /** Live settings face, injected once the optional `settings` service resolves; null until then. */
  settings: () => SettingsFace | null
}

interface ProviderWire {
  id: string
  displayName?: string
  api?: string
  baseURL?: string
  apiKeyEnv?: string
  modelCount: number
  fields: string[]
}

interface ProviderSideWire {
  available: boolean
  reason?: string
  revision?: number
  patchPath?: string
  providers?: ProviderWire[]
}

interface ProvidersPayload {
  source: ProviderSideWire
  engine: ProviderSideWire
  diff: ProviderDiff | null
  sync: {
    mode: SyncMode
    exclude: string[]
    autoSync: boolean
    autoRestart: boolean
    busy: boolean
    lastReport: SyncReport | null
    lastError: string | null
  }
}

interface StatusPayload extends DetectResult {
  installRunning: boolean
  setup: SetupState
}

/** Single-flight provider sync, shared by the manual route and the auto-sync watcher. */
let syncing = false
let lastSyncReport: SyncReport | null = null
let lastSyncError: string | null = null

export function providerSyncBusy(): boolean {
  return syncing
}

/** Run one sync under the shared lock; resolves with the report, rejects on failure. */
export async function runProviderSync(
  config: ResolvedConsoleConfig,
  settings: SettingsFace | null,
  mode?: SyncMode,
): Promise<SyncReport> {
  if (syncing) throw new Error('a provider sync is already running')
  syncing = true
  try {
    const report = applyProviderSync(config, settings, { mode, exclude: config.syncExclude })
    lastSyncReport = report
    lastSyncError = null
    return report
  } catch (error) {
    lastSyncError = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    syncing = false
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

async function readBody(req: IncomingMessage, cap = 8 * 1024): Promise<void> {
  for await (const chunk of req) {
    if ((chunk as Buffer).length > cap) throw new Error('unexpected request body')
    void chunk
  }
}

/** Read a small JSON request body; malformed or oversized bodies are 400s. */
async function readJson<T>(req: IncomingMessage, cap = 8 * 1024): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > cap) throw new PluginRequestError('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new PluginRequestError('request body must be JSON')
  }
}

export function consoleApiHandler(options: ConsoleApiOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { config, env } = options

  async function statusPayload(): Promise<StatusPayload> {
    const result = await detect(config, env)
    return { ...result, installRunning: installBusy(), setup: readSetupState(config) }
  }

  function providersPayload(): ProvidersPayload {
    const settings = options.settings()
    const source = readHostProviders(settings)
    const patchPath = enginePatchPath(config)
    const engine = readEngineProviders(patchPath)
    const wire = (side: ReturnType<typeof readHostProviders>): ProviderSideWire => ({
      available: side.available,
      reason: side.reason,
      revision: side.revision,
      patchPath: side.patchPath,
      providers: side.providers
        ? Object.entries(side.providers).map(([id, value]) => {
            const summary = summarizeProvider(id, value)
            return { id, displayName: summary.displayName, api: summary.api, baseURL: summary.baseURL, apiKeyEnv: summary.apiKeyEnv, modelCount: summary.modelCount, fields: summary.fieldNames }
          })
        : undefined,
    })
    const diff = source.available && engine.available && source.providers && engine.providers
      ? diffProviders(source.providers, engine.providers)
      : null
    return {
      source: wire(source),
      engine: wire(engine),
      diff,
      sync: {
        mode: config.syncMode,
        exclude: config.syncExclude,
        autoSync: config.autoSync,
        autoRestart: config.autoRestart,
        busy: syncing,
        lastReport: lastSyncReport,
        lastError: lastSyncError,
      },
    }
  }

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://console.local')
    const route = `${req.method ?? 'GET'} ${url.pathname}`
    try {
      switch (route) {
        case 'GET /superagent-console/api/status': {
          sendJson(res, 200, await statusPayload())
          return
        }
        case 'GET /superagent-console/api/setup': {
          sendJson(res, 200, { running: installBusy(), setup: readSetupState(config) })
          return
        }
        case 'POST /superagent-console/api/install': {
          await readBody(req)
          if (installBusy()) {
            sendJson(res, 409, { error: 'an install is already running' })
            return
          }
          void runInstall(config, env).catch(() => undefined)
          sendJson(res, 202, { started: true })
          return
        }
        case 'POST /superagent-console/api/install/reset': {
          await readBody(req)
          if (installBusy()) {
            sendJson(res, 409, { error: 'an install is already running' })
            return
          }
          sendJson(res, 200, { setup: resetInstallState(config) })
          return
        }
        case 'POST /superagent-console/api/engine/start':
        case 'POST /superagent-console/api/engine/restart': {
          await readBody(req)
          const action = route.endsWith('/start') ? 'start' : 'restart'
          const result: EngineActionResult = await engineAction(config, action, env)
          sendJson(res, result.ok ? 200 : 502, result)
          return
        }
        case 'GET /superagent-console/api/plugins': {
          sendJson(res, 200, { ...pluginsState(config), operation: pluginOperation() })
          return
        }
        case 'GET /superagent-console/api/plugins/operation': {
          sendJson(res, 200, pluginOperation())
          return
        }
        case 'POST /superagent-console/api/plugins/install': {
          const body = await readJson<{ spec?: unknown }>(req)
          if (pluginBusy()) {
            sendJson(res, 409, { error: 'another plugin operation is already running' })
            return
          }
          void runPluginOperation(config, env, 'install', String(body.spec ?? '')).catch(() => undefined)
          sendJson(res, 202, { started: true })
          return
        }
        case 'POST /superagent-console/api/plugins/remove': {
          const body = await readJson<{ name?: unknown }>(req)
          if (pluginBusy()) {
            sendJson(res, 409, { error: 'another plugin operation is already running' })
            return
          }
          void runPluginOperation(config, env, 'remove', String(body.name ?? '')).catch(() => undefined)
          sendJson(res, 202, { started: true })
          return
        }
        case 'POST /superagent-console/api/plugins/enable': {
          const body = await readJson<{ name?: unknown; enabled?: unknown }>(req)
          const rows = await setBundleEnabled(config, body.name, body.enabled === true)
          sendJson(res, 200, rows)
          return
        }
        case 'GET /superagent-console/api/providers': {
          sendJson(res, 200, providersPayload())
          return
        }
        case 'POST /superagent-console/api/providers/sync': {
          const body = await new Promise<string>((resolve, reject) => {
            let text = ''
            req.on('data', (chunk) => { text += chunk })
            req.on('end', () => resolve(text))
            req.on('error', reject)
          }).catch(() => '')
          let mode: SyncMode | undefined
          try {
            const parsed = JSON.parse(body || '{}') as { mode?: string }
            if (parsed.mode === 'merge' || parsed.mode === 'mirror') mode = parsed.mode
          } catch { /* default mode applies */ }
          if (syncing) {
            sendJson(res, 409, { error: 'a provider sync is already running' })
            return
          }
          try {
            const report = await runProviderSync(config, options.settings(), mode)
            sendJson(res, 200, { report })
          } catch (error) {
            sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        default: {
          if (url.pathname.startsWith('/superagent-console/api/')) {
            sendJson(res, 404, { error: `no console route: ${route}` })
            return
          }
          sendJson(res, 404, { error: 'not found' })
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = error instanceof PluginRequestError ? error.status : 500
      if (!res.headersSent) sendJson(res, status, { error: message })
      else res.end()
    }
  }
}
