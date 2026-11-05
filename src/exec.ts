/**
 * Shared process runner for detection and installation stages.
 *
 * Every spawn goes through `execFile` with an argv array (never a shell
 * string), an explicit timeout, and an augmented PATH: the desktop app
 * process may run with a minimal GUI PATH, so the node installation bin
 * directory, the configured `extraPath` entries, and the app's bundled
 * dsh CLI directory are prepended (in that order; user entries win).
 */
import { execFile, spawn } from 'node:child_process'
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

export interface StreamingRun {
  promise: Promise<RunResult>
  /** Terminate the child (SIGKILL); the promise still resolves with the partial result. */
  kill: () => void
}

/**
 * Spawn like {@link run} but deliver output as it arrives: the plugins API
 * mirrors each chunk into the operation state so the dialog can stream the
 * install log the way the native manager does. Output stays bounded by the
 * consumer (it keeps a tail); this runner only concatenates what it saw.
 */
export function runStreaming(argv: string[], options: RunOptions = {}, onChunk?: (text: string) => void): StreamingRun {
  const [file, ...args] = argv
  if (!file) throw new Error('runStreaming() needs a command')
  const { cwd, timeoutMs = 30_000, extraPath } = options
  const child = spawn(file, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: spawnPath(extraPath) },
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, timeoutMs)
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); onChunk?.(chunk.toString()) })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); onChunk?.(chunk.toString()) })
  const promise = new Promise<RunResult>((resolve) => {
    const startedAt = Date.now()
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(error), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const hitTimeout = timedOut && Date.now() - startedAt >= timeoutMs - 1
      resolve({ code: code ?? (timedOut || hitTimeout ? -1 : 0), stdout, stderr, timedOut: timedOut || hitTimeout })
    })
  })
  return { promise, kill: () => { clearTimeout(timer); child.kill('SIGKILL') } }
}

/** Truncate captured output for audit logging. */
export function tail(text: string, max = 2000): string {
  const value = text.trim()
  return value.length <= max ? value : `…${value.slice(-max)}`
}
