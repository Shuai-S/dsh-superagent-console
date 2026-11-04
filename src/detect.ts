/**
 * Layered engine detection (L0-L3), side-effect free.
 *
 * L0 engine reachable  — management API answers at the configured target.
 * L1 service installed — dedicated profile exists and references the engine
 *                        bundle; the installer-owned checkout is buildable.
 * L2 engine health     — scripts/dsh-superagent status exit code semantics:
 *                        0 healthy, 1 stopped, 2 component error, 3 setup wait.
 * L3 prerequisites     — toolchain binaries needed for the online installer.
 *
 * The reported state maps to exactly one UI action in the setup card:
 * running → panel, installed-stopped → start, installed-unhealthy → restart,
 * not-installed → install, prereq-missing → fix the listed tools.
 */
import os from 'node:os'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import type { ResolvedConsoleConfig } from './config.ts'
import { run, spawnPath } from './exec.ts'

export type ConsoleState =
  | 'running'
  | 'installed-stopped'
  | 'installed-unhealthy'
  | 'not-installed'
  | 'prereq-missing'

export interface Prereq {
  name: string
  ok: boolean
  detail: string
  /** Suggested remediation command for a failed check; absent when none applies. */
  hint?: string
}

export interface EngineHealth {
  exit: number
  pids: number[]
  url: string | null
  manuallyStopped: boolean
  health: Record<string, string> | null
  errors: Record<string, string> | null
  setup: string | null
}

export interface DetectResult {
  state: ConsoleState
  target: string
  engineReachable: boolean
  profileInstalled: boolean
  patchMissing: boolean
  checkoutValid: boolean
  health: EngineHealth | null
  prereqs: Prereq[]
}

export interface DetectEnv {
  extraPath?: string
}

/** Tools the online installer and the lifecycle script need; `node` is checked in-process. */
const TOOL_CHECKS: Array<{ name: string; argv: string[]; min?: string }> = [
  { name: 'dsh', argv: ['dsh', '--version'], min: '0.2.1' },
  { name: 'pnpm', argv: ['pnpm', '--version'], min: '9.0.0' },
  { name: 'git', argv: ['git', '--version'], min: '2.32.0' },
  { name: 'tmux', argv: ['tmux', '-V'] },
  { name: 'python3', argv: ['python3', '--version'] },
]

function parseVersion(version: string): number[] {
  return version
    .trim()
    .replace(/^v/, '')
    .split(/[-+\s]/)[0]!
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
}

function atLeast(version: string, min: string): boolean {
  const a = parseVersion(version)
  const b = parseVersion(min)
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return true
}

function nodeOk(): Prereq {
  const version = process.version
  const major = parseVersion(version)[0] ?? 0
  const ok = (major === 22 && atLeast(version, '22.19.0')) || major >= 24
  return { name: 'node', ok, detail: ok ? version : `${version} (needs ^22.19.0 or >=24.0.0)` }
}

export function profileDir(profileName: string): string {
  return path.join(os.homedir(), '.dsh', 'profiles', profileName)
}

export function consoleStateDir(engineDir: string): string {
  return path.dirname(engineDir)
}

/** Profile-level install markers: bundle dependency and the machine patch file. */
export function profileInfo(profileName: string): { installed: boolean; patchMissing: boolean } {
  const dir = profileDir(profileName)
  const packageJsonPath = path.join(dir, 'package.json')
  let installed = false
  try {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    installed = Boolean(manifest.dependencies?.['dsh-superagent'])
  } catch {
    installed = false
  }
  return { installed, patchMissing: !existsSync(path.join(dir, 'cordis.patch.yml')) }
}

/** Buildable checkout markers inside the installer-owned engine directory. */
export function checkoutValid(engineDir: string): boolean {
  return (
    existsSync(path.join(engineDir, 'lib', 'index.js')) &&
    existsSync(path.join(engineDir, 'lib', 'client.js')) &&
    existsSync(path.join(engineDir, 'scripts', 'dsh-superagent'))
  )
}

/** L0: does the management API answer at the target? Server-side fetch, loopback host. */
export async function probeEngine(target: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const response = await fetch(target.replace(/\/$/, '') + '/orchestrator/api/state', {
      headers: { 'x-orchestrator-request': '1' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

/** L2: run the lifecycle script's status action and parse its JSON output. */
export async function engineHealth(engineDir: string, profileName: string, target: string, env: DetectEnv = {}): Promise<EngineHealth | null> {
  const script = path.join(engineDir, 'scripts', 'dsh-superagent')
  if (!existsSync(script)) return null
  const result = await run(['python3', script, 'status', '--profile', profileName, '--url', target], {
    timeoutMs: 15_000,
    extraPath: env.extraPath,
  })
  if (!result.stdout.trim()) return null
  try {
    const parsed = JSON.parse(result.stdout) as {
      pids?: number[]
      url?: string
      manually_stopped?: boolean
      health?: Record<string, string> | null
      errors?: Record<string, string> | null
      setup?: string | null
    }
    return {
      exit: result.code,
      pids: parsed.pids ?? [],
      url: parsed.url ?? null,
      manuallyStopped: Boolean(parsed.manually_stopped),
      health: parsed.health ?? null,
      errors: parsed.errors ?? null,
      setup: parsed.setup ?? null,
    }
  } catch {
    return { exit: result.code, pids: [], url: null, manuallyStopped: false, health: null, errors: null, setup: result.stderr || result.stdout }
  }
}

/** Locale-neutral remediation commands surfaced next to a failed check (darwin only). */
function missingHint(name: string): string | undefined {
  if (process.platform !== 'darwin') return undefined
  if (name === 'tmux') return 'brew install tmux'
  if (name === 'pnpm') return 'npm install -g pnpm'
  return undefined
}

/** L3: toolchain probe; never throws, missing tools surface as ok:false entries (with a hint where one applies). */
export async function prereqCheck(env: DetectEnv = {}): Promise<Prereq[]> {
  const checks: Prereq[] = [nodeOk()]
  for (const tool of TOOL_CHECKS) {
    const result = await run(tool.argv, { timeoutMs: 10_000, extraPath: env.extraPath })
    const output = `${result.stdout} ${result.stderr}`.trim()
    if (result.code !== 0 || !output) {
      checks.push({ name: tool.name, ok: false, detail: result.code === -1 ? 'not found on PATH' : tail(output, 200), hint: missingHint(tool.name) })
      continue
    }
    const version = output.split(/\s+/).find((token) => /^\d/.test(token)) ?? output
    const ok = tool.min ? atLeast(version, tool.min) : true
    checks.push({ name: tool.name, ok, detail: ok ? version : `${version} (needs >= ${tool.min})`, hint: ok ? undefined : missingHint(tool.name) })
  }
  return checks
}

function tail(text: string, max: number): string {
  const value = text.trim()
  return value.length <= max ? value : `…${value.slice(-max)}`
}

/** Run all layers once and map to the single UI state. Never throws. */
export async function detect(config: ResolvedConsoleConfig, env: DetectEnv = {}): Promise<DetectResult> {
  const engineDir = config.engineDir
  const engineReachable = await probeEngine(config.target)
  const profile = profileInfo(config.profileName)
  const checkout = checkoutValid(engineDir)
  const prereqs = await prereqCheck(env)
  const coreOk = prereqs.every((item) => item.ok)

  let health: EngineHealth | null = null
  let state: ConsoleState
  if (engineReachable) {
    state = 'running'
    health = await engineHealth(engineDir, config.profileName, config.target, env)
  } else if (!profile.installed || !checkout) {
    state = coreOk ? 'not-installed' : 'prereq-missing'
  } else {
    health = await engineHealth(engineDir, config.profileName, config.target, env)
    if (health?.exit === 1) state = 'installed-stopped'
    else state = 'installed-unhealthy'
  }

  return {
    state,
    target: config.target,
    engineReachable,
    profileInstalled: profile.installed,
    patchMissing: profile.patchMissing,
    checkoutValid: checkout,
    health,
    prereqs,
  }
}

export { spawnPath }
