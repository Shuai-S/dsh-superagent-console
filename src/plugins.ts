/**
 * Engine plugin management — a guarded console surface over the engine
 * profile's package manifest and `dsh plugin --profile <name>`.
 *
 * The superagent engine runs in its own DSH profile; its "plugins" are that
 * profile's dependencies, mounted as composition bundles when the package
 * declares a `dsh.bundle` patch and its name sits in
 * `dsh.profile.bundles`. Mutations therefore go through the official CLI
 * path (`dsh plugin ... add/remove` = locked pnpm in the profile plus the
 * same bundle reconciliation the running manager performs), and bundle
 * selection is a manifest-only JSON edit that takes effect at the next
 * engine start.
 *
 * Guards:
 *   - every spawn is `execFile` with an argv array (no shell), explicit
 *     timeout, and the augmented PATH shared with the installer;
 *   - the desktop profile is refused unconditionally (never the console's
 *     own host profile);
 *   - install specs must be non-empty, option-free single tokens; remove
 *     names must already be profile dependencies;
 *   - the engine core package (`dsh-superagent`) can be neither removed
 *     nor toggled — without it the console has no subject;
 *   - operations are single-flight in-process: install, remove, and
 *     selection edits share one mutex so they cannot interleave.
 */
import path from 'node:path'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ResolvedConsoleConfig } from './config.ts'
import { consoleStateDir, profileDir } from './detect.ts'
import { run, tail } from './exec.ts'

/** A request the caller (not the environment) got wrong — reported as HTTP 400. */
export class PluginRequestError extends Error {
  readonly status = 400
}

/** Packages whose removal or disable would take the engine itself down. */
const PROTECTED_CORE = ['dsh-superagent'] as const

export interface PluginRow {
  name: string
  /** Dependency value recorded in the profile manifest (spec, git URL, link: path…). */
  spec: string
  /** Installed version read from the package manifest; null when unreadable. */
  version: string | null
  description: string | null
  /** The package declares a dsh.bundle patch, so it can mount as a plugin layer. */
  bundle: boolean
  /** Currently selected in dsh.profile.bundles (mounts at engine start). */
  enabled: boolean
  /** Engine-core package: remove and toggle are refused. */
  protectedCore: boolean
}

export interface PluginsState {
  profileName: string
  profileDir: string
  profileInstalled: boolean
  rows: PluginRow[]
}

export type PluginOperationKind = 'install' | 'remove'

export interface PluginOperation {
  running: boolean
  kind: PluginOperationKind | null
  /** Install spec or package name of the current/last operation. */
  target: string | null
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
  timedOut: boolean
  /** Redacted combined command output tail. */
  output: string
  error: string | null
}

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

interface InstalledManifest {
  version?: string
  description?: string
  dsh?: { bundle?: unknown }
}

export interface PluginEnv {
  extraPath?: string
}

/** Redact user:password@ credentials before output reaches the API or audit log. */
function redact(text: string): string {
  return text.replace(/(:\/\/)([^@/\s]+)@/g, '$1***@')
}

function readManifest(profileName: string): ProfileManifest | null {
  try {
    return JSON.parse(readFileSync(path.join(profileDir(profileName), 'package.json'), 'utf8')) as ProfileManifest
  } catch {
    return null
  }
}

function readInstalledManifest(profileName: string, name: string): InstalledManifest | null {
  try {
    return JSON.parse(readFileSync(path.join(profileDir(profileName), 'node_modules', name, 'package.json'), 'utf8')) as InstalledManifest
  } catch {
    return null
  }
}

/** Read the plugin roster: profile dependencies resolved against the profile's node_modules. */
export function pluginsState(config: ResolvedConsoleConfig): PluginsState {
  const dir = profileDir(config.profileName)
  const manifest = readManifest(config.profileName)
  if (!manifest) {
    return { profileName: config.profileName, profileDir: dir, profileInstalled: false, rows: [] }
  }
  const selected = new Set(manifest.dsh?.profile?.bundles ?? [])
  const rows: PluginRow[] = Object.entries(manifest.dependencies ?? {}).map(([name, spec]) => {
    const installed = readInstalledManifest(config.profileName, name)
    const declaredBundle = installed?.dsh?.bundle !== undefined
    return {
      name,
      spec,
      version: typeof installed?.version === 'string' ? installed.version : null,
      description: typeof installed?.description === 'string' && installed.description ? installed.description : null,
      bundle: declaredBundle,
      enabled: selected.has(name),
      protectedCore: (PROTECTED_CORE as readonly string[]).includes(name),
    }
  })
  rows.sort((a, b) => Number(b.protectedCore) - Number(a.protectedCore) || a.name.localeCompare(b.name))
  return { profileName: config.profileName, profileDir: dir, profileInstalled: true, rows }
}

// ── single-flight operations ────────────────────────────────────────────────

let inFlight: Promise<PluginOperation> | null = null
let last: PluginOperation = {
  running: false, kind: null, target: null, startedAt: null, finishedAt: null,
  exitCode: null, timedOut: false, output: '', error: null,
}

/** Whether an install/remove/selection operation is executing in this process. */
export function pluginBusy(): boolean {
  return inFlight !== null
}

/** Current or last finished operation, as served to the polling client. */
export function pluginOperation(): PluginOperation {
  return inFlight !== null ? { ...last, running: true } : { ...last }
}

function audit(config: ResolvedConsoleConfig, entry: Record<string, unknown>): void {
  try {
    mkdirSync(consoleStateDir(config.engineDir), { recursive: true })
    appendFileSync(path.join(consoleStateDir(config.engineDir), 'audit.jsonl'), JSON.stringify(entry) + '\n')
  } catch {
    // Audit logging must never break the operation itself.
  }
}

/** Validate an install spec: one option-free token the CLI can pass to pnpm. */
function validateSpec(raw: unknown): string {
  const spec = typeof raw === 'string' ? raw.trim() : ''
  if (!spec || spec.length > 512 || /[\r\n]/.test(spec) || spec.startsWith('-')) {
    throw new PluginRequestError('invalid plugin spec: a non-empty package name, git URL, tarball, or absolute path is required')
  }
  return spec
}

/** Validate a remove/enable target: an existing profile dependency, not the engine core. */
function validateName(config: ResolvedConsoleConfig, raw: unknown, allowProtected = false): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name || name.length > 214 || /[\r\n]/.test(name) || name.startsWith('-')) {
    throw new PluginRequestError('invalid plugin name')
  }
  if ((PROTECTED_CORE as readonly string[]).includes(name) && !allowProtected) {
    throw new PluginRequestError(name + ' is the engine core and cannot be removed or disabled')
  }
  const dependencies = readManifest(config.profileName)?.dependencies ?? {}
  if (!Object.hasOwn(dependencies, name)) {
    throw new PluginRequestError(name + ' is not a dependency of the ' + config.profileName + ' profile')
  }
  return name
}

async function runCliOperation(config: ResolvedConsoleConfig, env: PluginEnv, kind: PluginOperationKind, target: string): Promise<PluginOperation> {
  const startedAt = new Date().toISOString()
  const argv = ['dsh', 'plugin', '--profile', config.profileName, kind === 'install' ? 'add' : 'remove', target]
  audit(config, { ts: startedAt, event: 'plugin-' + kind + '-begin', profile: config.profileName, target: redact(target) })
  const result = await run(argv, { timeoutMs: kind === 'install' ? 900_000 : 600_000, extraPath: env.extraPath })
  const output = tail(redact((result.stdout + '\n' + result.stderr).trim()), 4000)
  const failed = result.code !== 0
  const state: PluginOperation = {
    running: false,
    kind,
    target,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.code,
    timedOut: result.timedOut,
    output,
    error: failed
      ? (result.timedOut ? 'command timed out' : `exit ${result.code}`)
      : null,
  }
  last = state
  audit(config, {
    ts: state.finishedAt!, event: 'plugin-' + kind + '-end', profile: config.profileName,
    target: redact(target), exit: result.code, timedOut: result.timedOut,
  })
  return state
}

/**
 * Start an install/remove operation; resolves with the completed state.
 * Rejects immediately (PluginRequestError) when an operation is already
 * running, and surfaces command failures as the resolved state's error.
 */
export function runPluginOperation(config: ResolvedConsoleConfig, env: PluginEnv, kind: PluginOperationKind, target: string): Promise<PluginOperation> {
  if (config.profileName === 'desktop') {
    return Promise.reject(new PluginRequestError('refusing to manage plugins of the desktop profile'))
  }
  if (inFlight) return Promise.reject(new PluginRequestError('another plugin operation is already running'))
  const prepared = kind === 'install' ? validateSpec(target) : validateName(config, target)
  last = { running: true, kind, target: prepared, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, timedOut: false, output: '', error: null }
  inFlight = runCliOperation(config, env, kind, prepared).finally(() => {
    inFlight = null
  })
  return inFlight
}

/**
 * Select or deselect a dependency's bundle layer in the profile manifest
 * (JSON edit; applies at the next engine start). Runs under the same
 * single-flight mutex as install/remove so manifest edits cannot interleave
 * with a locked pnpm run.
 */
export async function setBundleEnabled(config: ResolvedConsoleConfig, rawName: unknown, enabled: boolean): Promise<PluginsState> {
  if (config.profileName === 'desktop') {
    throw new PluginRequestError('refusing to manage plugins of the desktop profile')
  }
  if (inFlight) throw new PluginRequestError('another plugin operation is already running')
  const name = validateName(config, rawName)
  const manifest = readManifest(config.profileName)
  if (!manifest) throw new PluginRequestError('the ' + config.profileName + ' profile has no readable package.json')
  const installed = readInstalledManifest(config.profileName, name)
  if (installed?.dsh?.bundle === undefined) {
    throw new PluginRequestError(name + ' declares no dsh.bundle; it cannot be mounted or unmounted as a plugin layer')
  }
  const previous = manifest.dsh?.profile?.bundles ?? []
  const changed = enabled ? !previous.includes(name) : previous.includes(name)
  if (changed) {
    const bundles = enabled ? [...previous, name] : previous.filter((item) => item !== name)
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    const file = path.join(profileDir(config.profileName), 'package.json')
    // Preserve the profile manifest's 0600 mode: write a same-directory
    // temporary file with the restricted mode, then atomically rename it.
    const temporary = file + '.superagent-console-tmp'
    writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, file)
    audit(config, { ts: new Date().toISOString(), event: 'plugin-select', profile: config.profileName, target: name, enabled })
  }
  return pluginsState(config)
}
