/**
 * Shared process runner for detection and installation stages.
 *
 * Every spawn goes through `execFile` with an argv array (never a shell
 * string), an explicit timeout, and an augmented PATH: the desktop app
 * process may run with a minimal GUI PATH, so the node installation bin
 * directory, the configured `extraPath` entries, and the app's bundled
 * dsh CLI directory are prepended (in that order; user entries win).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface RunOptions {
  /** Working directory for the spawned command. */
  cwd?: string
  /** Kill the child after this many milliseconds; the result carries `timedOut`. */
  timeoutMs?: number
  /** Extra PATH entries (colon-separated, `~` already expanded) prepended to the inherited PATH. */
  extraPath?: string
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
}

const MAX_BUFFER = 16 * 1024 * 1024

/**
 * Directory of the dsh CLI shipped inside the desktop app bundle: the
 * Electron binary lives at `<App>.app/Contents/MacOS/<bin>`, so the bundled
 * CLI resolves to `../Resources/runtime/cli/bin`. Null outside an app
 * bundle (plain node runs, tests) or when the bundle carries no CLI.
 * Uncached on purpose: spawns are rare and the probe is one existsSync.
 */
export function bundledCliDir(execPath = process.execPath): string | null {
  const candidate = path.join(path.dirname(execPath), '..', 'Resources', 'runtime', 'cli', 'bin')
  return existsSync(path.join(candidate, 'dsh')) ? candidate : null
}

/**
 * PATH prepended for every spawned tool: the running node's bin dir, the
 * configured extras, the app's bundled CLI dir (fallback only, so an
 * explicit user install keeps winning), then the inherited PATH.
 */
export function spawnPath(extraPath?: string): string {
  const parts = [path.dirname(process.execPath)]
  if (extraPath) parts.push(...extraPath.split(':').filter(Boolean))
  const bundled = bundledCliDir()
  if (bundled) parts.push(bundled)
  const inherited = process.env.PATH ?? ''
  return [...parts, inherited].filter(Boolean).join(':')
}

export function run(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const [file, ...args] = argv
  if (!file) throw new Error('run() needs a command')
  const { cwd, timeoutMs = 30_000, extraPath } = options
  return new Promise((resolve) => {
    const startedAt = Date.now()
    execFile(
      file,
      args,
      {
        cwd,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, PATH: spawnPath(extraPath) },
      },
      (error, stdout, stderr) => {
        const timedOut = Boolean(error && (error as { killed?: boolean }).killed && Date.now() - startedAt >= timeoutMs - 1)
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? -1 : 0
        resolve({
          code,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          timedOut,
        })
      },
    )
  })
}

/** Truncate captured output for audit logging. */
export function tail(text: string, max = 2000): string {
  const value = text.trim()
  return value.length <= max ? value : `…${value.slice(-max)}`
}
