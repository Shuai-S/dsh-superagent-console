/**
 * Online installer for the Superagent engine — a staged, guarded pipeline.
 *
 * Stage order: prereqs → checkout → build → profile → plugin → patch → start → verify.
 * Each stage is idempotent (re-running skips completed work), persisted to
 * `setup.json` (resume across desktop restarts), audited to `audit.jsonl`,
 * and guarded:
 *   - `dsh <profile> --from-default-profile web` REPLACES an existing profile,
 *     so the profile stage refuses to run when the profile directory exists;
 *   - the patch stage never overwrites an existing cordis.patch.yml (it holds
 *     operator-owned Source configuration);
 *   - the checkout stage refuses a non-empty, non-git target directory;
 *   - only one install runs at a time (in-process mutex + pid lockfile).
 *
 * Commands run through execFile with argv arrays only — no shell interpolation.
 */
import os from 'node:os'
import path from 'node:path'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { ResolvedConsoleConfig } from './config.ts'
import { checkoutValid, consoleStateDir, prereqCheck, probeEngine, profileDir } from './detect.ts'
import { run, tail } from './exec.ts'

export type StageId = 'prereqs' | 'checkout' | 'build' | 'profile' | 'plugin' | 'patch' | 'start' | 'verify'

export const STAGE_ORDER: StageId[] = ['prereqs', 'checkout', 'build', 'profile', 'plugin', 'patch', 'start', 'verify']

export type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export interface StageState {
  status: StageStatus
  detail?: string
  startedAt?: string
  finishedAt?: string
}

export interface SetupState {
  running: boolean
  current: StageId | null
  stages: Record<StageId, StageState>
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

export interface InstallEnv {
  extraPath?: string
}

function freshState(): SetupState {
  const stages = {} as Record<StageId, StageState>
  for (const stage of STAGE_ORDER) stages[stage] = { status: 'pending' }
  return { running: false, current: null, stages, startedAt: null, finishedAt: null, error: null }
}

function setupPath(config: ResolvedConsoleConfig): string {
  return path.join(consoleStateDir(config.engineDir), 'setup.json')
}

export function readSetupState(config: ResolvedConsoleConfig): SetupState {
  try {
    return JSON.parse(readFileSync(setupPath(config), 'utf8')) as SetupState
  } catch {
    return freshState()
  }
}

function saveState(config: ResolvedConsoleConfig, state: SetupState): void {
  mkdirSync(consoleStateDir(config.engineDir), { recursive: true })
  writeFileSync(setupPath(config), JSON.stringify(state, null, 2) + '\n')
}

/** Redact user:password@ credentials before they reach the audit log. */
function redact(text: string): string {
  return text.replace(/(:\/\/)([^@/\s]+)@/g, '$1***@')
}

function audit(config: ResolvedConsoleConfig, entry: Record<string, unknown>): void {
  try {
    mkdirSync(consoleStateDir(config.engineDir), { recursive: true })
    appendFileSync(path.join(consoleStateDir(config.engineDir), 'audit.jsonl'), JSON.stringify(entry) + '\n')
  } catch {
    // Audit logging must never break the pipeline itself.
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let inFlight: Promise<SetupState> | null = null

/** Whether an install is currently executing in this process. */
export function installBusy(): boolean {
  return inFlight !== null
}

async function runStage(command: string[], options: { cwd?: string; timeoutMs: number; extraPath?: string }): Promise<string> {
  const result = await run(command, { cwd: options.cwd, timeoutMs: options.timeoutMs, extraPath: options.extraPath })
  if (result.code !== 0) {
    throw new Error(`$ ${redact(command.join(' '))}\nexit ${result.code}${result.timedOut ? ' (timeout)' : ''}\n${tail(result.stderr || result.stdout, 1500)}`)
  }
  return tail(result.stdout, 1500)
}

async function stagePrereqs(config: ResolvedConsoleConfig, env: InstallEnv): Promise<string> {
  const checks = await prereqCheck(env)
  const missing = checks.filter((item) => !item.ok).map((item) => `${item.name}: ${item.detail}`)
  if (missing.length > 0) throw new Error(`Missing prerequisites — ${missing.join('; ')}`)
  const registry = await fetch('https://registry.npmjs.org/@deepseek-ai/dsh', { method: 'HEAD', signal: AbortSignal.timeout(10_000) }).then((r) => r.ok).catch(() => false)
  if (!registry) throw new Error('npm registry unreachable (https://registry.npmjs.org)')
  const lsRemote = await run(['git', 'ls-remote', config.repoUrl, 'HEAD'], { timeoutMs: 25_000, extraPath: env.extraPath })
  if (lsRemote.code !== 0) {
    throw new Error(`Cannot reach ${redact(config.repoUrl)} over git — ${tail(lsRemote.stderr || lsRemote.stdout, 300)}`)
  }
  return `tools ok; registry ok; repository reachable (${tail(lsRemote.stdout, 40)})`
}

async function stageCheckout(config: ResolvedConsoleConfig, env: InstallEnv): Promise<string> {
  if (existsSync(path.join(config.engineDir, '.git'))) return 'skipped: checkout already present'
  if (existsSync(config.engineDir) && readdirSync(config.engineDir).length > 0) {
    throw new Error(`Refusing to clone into non-empty non-git directory: ${config.engineDir}`)
  }
  mkdirSync(consoleStateDir(config.engineDir), { recursive: true })
  const output = await runStage(['git', 'clone', config.repoUrl, config.engineDir], { timeoutMs: 600_000, extraPath: env.extraPath })
  if (!existsSync(path.join(config.engineDir, '.git'))) throw new Error('clone finished but .git is missing')
  return output
}

async function stageBuild(config: ResolvedConsoleConfig, env: InstallEnv): Promise<string> {
  if (checkoutValid(config.engineDir)) return 'skipped: build artifacts already present'
  const install = await runStage(['pnpm', 'install'], { cwd: config.engineDir, timeoutMs: 900_000, extraPath: env.extraPath })
  const build = await runStage(['pnpm', 'build'], { cwd: config.engineDir, timeoutMs: 600_000, extraPath: env.extraPath })
  if (!checkoutValid(config.engineDir)) throw new Error('build finished but lib/index.js / lib/client.js / scripts/dsh-superagent are missing')
  return `${install}\n${build}`
}

async function stageProfile(config: ResolvedConsoleConfig, env: InstallEnv): Promise<string> {
  if (config.profileName === 'desktop') throw new Error('refusing to install the engine into the desktop profile')
  const dir = profileDir(config.profileName)
  if (existsSync(dir)) return `skipped: profile directory already exists (${dir}) — bootstrap not run`
  // `--from-default-profile` REPLACES an existing profile with a fresh template
  // copy; the existsSync guard above is what makes this command safe to run.
  const output = await runStage(['dsh', config.profileName, '--from-default-profile', 'web', '--dump-config'], { timeoutMs: 180_000, extraPath: env.extraPath })
  if (!existsSync(path.join(dir, 'package.json'))) throw new Error('profile bootstrap finished but the profile directory is missing')
  return output
}

async function stagePlugin(config: ResolvedConsoleConfig, env: InstallEnv): Promise<string> {
  const output = await runStage(['dsh', 'plugin', '--profile', config.profileName, 'add', `link:${config.engineDir}`], { timeoutMs: 600_000, extraPath: env.extraPath })
  let installed = false
  try {
    const manifest = JSON.parse(readFileSync(path.join(profileDir(config.profileName), 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    installed = Boolean(manifest.dependencies?.['dsh-superagent'])
  } catch {
    installed = false
  }
  if (!installed) throw new Error('plugin add finished but dsh-superagent is not in the profile dependencies')
  return output
}

/** The untouched web-template patch is an empty list with a comment header — boilerplate, not operator config. */
function isTemplatePatch(content: string): boolean {
  const body = content.replace(/^#[^\n]*$/gm, '').trim()
  return body === '' || body === '[]'
}

async function stagePatch(config: ResolvedConsoleConfig): Promise<string> {
  const patchPath = path.join(profileDir(config.profileName), 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    const content = readFileSync(patchPath, 'utf8')
    // The untouched web-template patch is an empty list with a comment header —
    // boilerplate, safe to replace. Anything with real entries is operator
    // config (Source toggles, ports, stateDir) and is never touched, no matter
    // who created the profile.
    if (!isTemplatePatch(content)) {
      return `skipped: ${patchPath} already exists (operator-owned, not overwritten)`
    }
  }
  const url = new URL(config.target)
  const port = url.port
  if (!port) throw new Error(`target must include an explicit port, got ${config.target}`)
  const host = url.hostname
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error(`target host must be loopback, got ${host}`)
  const stateDir = path.join(os.homedir(), '.dsh', 'state', config.profileName)
  const content = [
    `# Generated by dsh-superagent-console installer on ${new Date().toISOString()}.`,
    '# Template: examples/profile.cordis.patch.yml — edit Source entries by hand; the installer only replaces the empty web-template patch.',
    '- id: webserver',
    '  config:',
    `    host: 127.0.0.1`,
    `    port: ${port}`,
    '- id: dsh-superagent',
    '  config:',
    `    stateDir: ${stateDir}`,
    '',
  ].join('\n')
  mkdirSync(path.dirname(patchPath), { recursive: true })
  writeFileSync(patchPath, content)
  return `wrote ${patchPath} (port ${port}, stateDir ${stateDir})`
}

async function stageStart(config: ResolvedConsoleConfig, env: InstallEnv): Promise<string> {
  const script = path.join(config.engineDir, 'scripts', 'dsh-superagent')
  // exit 0 = healthy; exit 3 = running and waiting for first-time setup — the
  // documented first-boot state, not a failure. Anything else is fatal.
  const result = await run(['python3', script, 'start', '--profile', config.profileName, '--url', config.target, '--timeout', '90'], { timeoutMs: 150_000, extraPath: env.extraPath })
  const output = tail(`${result.stdout}\n${result.stderr}`.trim(), 800)
  if (result.code === 0 || result.code === 3) return output
  throw new Error(`$ python3 …/scripts/dsh-superagent start …\nexit ${result.code}${result.timedOut ? ' (timeout)' : ''}\n${output}`)
}

async function stageVerify(config: ResolvedConsoleConfig, env: InstallEnv): Promise<string> {
  const script = path.join(config.engineDir, 'scripts', 'dsh-superagent')
  const deadline = Date.now() + 60_000
  let last = 'no status output'
  while (Date.now() < deadline) {
    const result = await run(['python3', script, 'status', '--profile', config.profileName, '--url', config.target], { timeoutMs: 20_000, extraPath: env.extraPath })
    if (result.code === 0 || result.code === 3) {
      const reachable = await probeEngine(config.target)
      return `engine status exit ${result.code}${result.code === 3 ? ' (waiting for setup — expected on first boot)' : ''}; management API ${reachable ? 'answering' : 'not answering yet'} at ${config.target}`
    }
    last = tail(result.stderr || result.stdout, 400)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(`engine did not become healthy within 60s — ${last}`)
}

const STAGE_FNS: Record<StageId, (config: ResolvedConsoleConfig, env: InstallEnv) => Promise<string>> = {
  prereqs: stagePrereqs,
  checkout: stageCheckout,
  build: stageBuild,
  profile: stageProfile,
  plugin: stagePlugin,
  patch: stagePatch,
  start: stageStart,
  verify: stageVerify,
}

/**
 * Execute the install pipeline. Resolves with the final state (failed stages
 * land in `stages[id].status === 'failed'` plus `error`), never throws except
 * for lock contention. Completed stages from a previous run are skipped.
 */
export function runInstall(config: ResolvedConsoleConfig, env: InstallEnv = {}): Promise<SetupState> {
  if (inFlight) return Promise.reject(new Error('an install is already running'))
  inFlight = executeInstall(config, env).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function executeInstall(config: ResolvedConsoleConfig, env: InstallEnv): Promise<SetupState> {
  const previous = readSetupState(config)
  // executeInstall only runs when no install is in flight in this process, so
  // a persisted running flag is stale (desktop crash mid-install). Either way
  // the new run starts from the persisted record: completed stages carry over
  // (resume), everything else resets to pending.
  if (previous.running) {
    audit(config, { ts: new Date().toISOString(), event: 'stale-running-reset' })
  }
  const state = freshState()
  for (const stage of STAGE_ORDER) {
    const stageState = previous.stages[stage]
    if (stageState?.status === 'done') state.stages[stage] = stageState
  }
  state.startedAt = previous.startedAt
  const lockPath = path.join(consoleStateDir(config.engineDir), 'install.lock')
  mkdirSync(consoleStateDir(config.engineDir), { recursive: true })
  try {
    const existing = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number }
    if (typeof existing.pid === 'number' && existing.pid !== process.pid && pidAlive(existing.pid)) {
      return { ...state, error: `another install appears active (pid ${existing.pid}); remove ${lockPath} if that is stale` }
    }
  } catch {
    // No lock file — take it.
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))

  state.running = true
  state.error = null
  state.startedAt = state.startedAt ?? new Date().toISOString()
  state.finishedAt = null
  saveState(config, state)
  audit(config, { ts: new Date().toISOString(), event: 'install-begin', target: config.target, profile: config.profileName })

  try {
    for (const stage of STAGE_ORDER) {
      const entry = state.stages[stage]
      if (entry.status === 'done') continue
      entry.status = 'running'
      entry.startedAt = new Date().toISOString()
      entry.finishedAt = undefined
      entry.detail = undefined
      state.current = stage
      saveState(config, state)
      try {
        entry.detail = await STAGE_FNS[stage](config, env)
        entry.status = 'done'
      } catch (error) {
        entry.status = 'failed'
        entry.detail = error instanceof Error ? error.message : String(error)
        state.error = `stage ${stage} failed: ${entry.detail}`
        saveState(config, state)
        audit(config, { ts: new Date().toISOString(), event: 'stage-failed', stage, detail: redact(entry.detail) })
        return state
      }
      entry.finishedAt = new Date().toISOString()
      saveState(config, state)
    }
    state.error = null
    return state
  } finally {
    state.running = false
    state.current = null
    state.finishedAt = new Date().toISOString()
    saveState(config, state)
    audit(config, { ts: new Date().toISOString(), event: 'install-end', error: state.error })
    try {
      rmSync(lockPath, { force: true })
    } catch {
      // Lock cleanup is best-effort; staleness is handled by the pid probe.
    }
  }
}

export interface EngineActionResult {
  ok: boolean
  exit: number
  output: string
}

/**
 * Locate the engine lifecycle script. Online installs own
 * `engineDir/scripts/dsh-superagent`; a manually installed engine lives in the
 * checkout the profile links (`dependencies['dsh-superagent'] = "link:<path>"`),
 * so resolve that too before giving up.
 */
export function resolveLifecycleScript(config: ResolvedConsoleConfig): { script: string | null; tried: string[] } {
  const tried: string[] = []
  const owned = path.join(config.engineDir, 'scripts', 'dsh-superagent')
  tried.push(owned)
  if (existsSync(owned)) return { script: owned, tried }
  try {
    const manifest = JSON.parse(readFileSync(path.join(profileDir(config.profileName), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const dep = manifest.dependencies?.['dsh-superagent']
    const link = typeof dep === 'string' && dep.startsWith('link:') ? dep.slice('link:'.length) : undefined
    if (link) {
      const linked = path.join(link, 'scripts', 'dsh-superagent')
      tried.push(linked)
      if (existsSync(linked)) return { script: linked, tried }
    }
  } catch { /* unreadable profile manifest — fall through */ }
  return { script: null, tried }
}

/** Run the lifecycle script's start/restart action and wait for its verdict. */
export async function engineAction(config: ResolvedConsoleConfig, action: 'start' | 'restart', env: InstallEnv = {}): Promise<EngineActionResult> {
  const { script, tried } = resolveLifecycleScript(config)
  if (!script) {
    return { ok: false, exit: 127, output: 'lifecycle script not found; looked at:\n  ' + tried.join('\n  ') }
  }
  const result = await run(['python3', script, action, '--profile', config.profileName, '--url', config.target, '--timeout', '90'], {
    timeoutMs: 420_000,
    extraPath: env.extraPath,
  })
  const ok = result.code === 0 || result.code === 3
  return { ok, exit: result.code, output: tail(`${result.stdout}\n${result.stderr}`.trim(), 2000) }
}

/** Reset persisted stage state (used when the operator wants a clean re-run). */
export function resetInstallState(config: ResolvedConsoleConfig): SetupState {
  const state = freshState()
  saveState(config, state)
  return state
}
