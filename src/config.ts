import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

/** How provider sync writes the engine profile: append missing only, or replace wholesale. */
export type SyncMode = 'merge' | 'mirror'

/** Resolved console settings `apply` reads. */
export type ResolvedConsoleConfig = {
  target: string
  repoUrl: string
  engineDir: string
  profileName: string
  extraPath: string
  syncMode: SyncMode
  syncExclude: string[]
  autoSync: boolean
  autoRestart: boolean
}

/** Expand a leading `~` to the user home so default paths stay machine-independent. */
export function expandHome(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

/**
 * Console settings section (auto-projected into the desktop plugin page).
 *
 * Defaults follow generic conventions: the engine checkout lives under the
 * console's own state directory (`~/.dsh/state/superagent-console/engine`),
 * never inside a user code directory the installer does not own.
 */
export const Config: z<ResolvedConsoleConfig, any> = z.object({
  target: z.string().default('http://127.0.0.1:3082').description('Superagent engine address (the dedicated profile web service)'),
  repoUrl: z.string().default('git@github.com:deepseek-ai/dsh-superagent-prototype.git').description('Engine source repository for the online installer (git clone)'),
  engineDir: z.string().default('~/.dsh/state/superagent-console/engine').description('Installer-owned directory holding the engine checkout (~ expanded)'),
  profileName: z.string().default('superagent').description('Dedicated DSH profile that runs the engine (never "desktop")'),
  extraPath: z.string().default('~/.local/bin:/usr/local/bin:/opt/homebrew/bin').description('Extra PATH entries for spawned engine tools (colon-separated, ~ expanded)'),
  syncMode: z.union([z.const('merge'), z.const('mirror')]).default('merge').description('Provider sync mode: merge appends missing providers, mirror replaces the engine providers map with the host one'),
  syncExclude: z.array(z.string()).default([]).description('Provider ids the sync never touches (neither copies nor removes)'),
  autoSync: z.boolean().default(false).description('Watch the host llm-pi-ai settings and sync the engine profile automatically when they change'),
  autoRestart: z.boolean().default(false).description('After an automatic sync, restart the engine when it is running (manual syncs always just prompt)'),
})
