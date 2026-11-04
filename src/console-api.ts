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
 *
 * The handler only executes fixed command templates; no request data ever
 * reaches an argv slot. Install state is served from setup.json so the card
 * can poll progress across desktop restarts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ResolvedConsoleConfig } from './config.ts'
import { detect, type DetectResult } from './detect.ts'
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

export interface ConsoleApiOptions {
  config: ResolvedConsoleConfig
  env: InstallEnv
}

interface StatusPayload extends DetectResult {
  installRunning: boolean
  setup: SetupState
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

export function consoleApiHandler(options: ConsoleApiOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { config, env } = options

  async function statusPayload(): Promise<StatusPayload> {
    const result = await detect(config, env)
    return { ...result, installRunning: installBusy(), setup: readSetupState(config) }
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
      if (!res.headersSent) sendJson(res, 500, { error: message })
      else res.end()
    }
  }
}
