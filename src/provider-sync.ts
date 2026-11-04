/**
 * Provider sync: carry the host profile's live `llm-pi-ai` model providers
 * into the dedicated engine profile's machine patch (`cordis.patch.yml`).
 *
 * The host side reads the settings service (`ctx.settings.describe()`, the
 * same seam dsh-sub2api-sync writes through), so the source is exactly what
 * the host composition currently serves. The engine side has no provider API
 * (its settings blocks are policy/eval/executor/pause/source only), so the
 * target is the engine profile patch file, edited surgically:
 *
 * - only the `llm-pi-ai` entry is touched; every other entry (Source config,
 *   webserver, agent-default-model) is preserved byte for byte, comments
 *   included — the file is never round-tripped through a YAML dump;
 * - `merge` only appends providers the engine lacks; `mirror` replaces the
 *   whole providers map with the host's (minus the exclusion list);
 * - every write is preceded by a timestamped backup (last 5 kept) and lands
 *   through a temp-file rename, and the new text must re-parse as YAML with
 *   the entry intact or the write is refused before it happens;
 * - providers carrying a plaintext secret field (apiKey/apiToken) are never
 *   copied — references (apiKeyEnv names) travel, secret values do not.
 *
 * @module dsh-superagent-console/provider-sync
 */
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ResolvedConsoleConfig } from './config.ts'
import { profileDir } from './detect.ts'

/** The settings namespace owned by dsh-llm-pi-ai (same constant sub2api-sync uses). */
export const PI_AI_ENTRY = 'llm-pi-ai'
/** The bundle name the engine profile entry references. */
const PI_AI_BUNDLE = '@deepseek-ai/dsh-llm-pi-ai'

/** Minimal structural view of the settings service the sync reads through. */
export interface SettingsFace {
  describe(): Array<{ ns: string; value?: unknown }>
}

export type SyncMode = 'merge' | 'mirror'

/** One provider's wire summary: identity and shape, never secret values. */
export interface ProviderSummary {
  displayName?: string
  api?: string
  baseURL?: string
  apiKeyEnv?: string
  modelCount: number
  fieldNames: string[]
}

export interface ProviderSide {
  available: boolean
  reason?: string
  revision?: number
  providers?: Record<string, unknown>
  patchPath?: string
}

export interface ProviderDiff {
  added: string[]
  changed: string[]
  removed: string[]
  unchanged: string[]
}

export interface SyncReport {
  mode: SyncMode
  changedFile: boolean
  backupPath?: string
  added: string[]
  changed: string[]
  removed: string[]
  skipped: Array<{ id: string; reason: string }>
  warnings: string[]
  /** Providers present on the engine side only after the sync (mirror keeps excluded ones). */
  engineProviders: string[]
  /** Whether the running engine confirmed the write in its catalog. */
  hotReload: HotReload
  /** True only when an engine is up but did not reflect the change in time. */
  needsRestart: boolean
}

/**
 * Outcome of waiting for the running engine to pick up the written providers.
 * `verified` — the engine's model catalog already reflects the change (the
 * engine watches its profile patch and hot-reloads llm-pi-ai); `offline` — no
 * engine is listening, so the change simply applies at next start; `timeout`
 * — an engine is up but did not reflect the change in time, restart is the
 * fallback.
 */
export type HotReload = 'verified' | 'offline' | 'timeout'

/** How the running engine's catalog view is probed after a write. */
async function engineCatalogProviders(target: string, timeoutMs = 2500): Promise<string[] | 'offline'> {
  try {
    const response = await fetch(target.replace(/\/$/, '') + '/orchestrator/api/models', {
      headers: { 'x-orchestrator-request': '1' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return 'offline'
    const payload = (await response.json()) as { groups?: Array<{ id?: string }> }
    return (payload.groups ?? []).map(group => group.id ?? '').filter(Boolean)
  } catch {
    return 'offline'
  }
}

/**
 * Wait until the engine's catalog contains every expected provider id (it
 * hot-reloads the profile patch), or run out of patience. Extra groups in the
 * catalog (account-backed providers) are fine — only coverage matters.
 */
async function awaitHotReload(target: string, expected: string[], budgetMs = 20_000, stepMs = 2_000): Promise<HotReload> {
  const deadline = Date.now() + budgetMs
  let offlineSeen = true
  while (Date.now() < deadline) {
    const providers = await engineCatalogProviders(target)
    if (providers !== 'offline') {
      offlineSeen = false
      if (expected.every(id => providers.includes(id))) return 'verified'
    }
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
  return offlineSeen ? 'offline' : 'timeout'
}

/** Field names that mean a plaintext secret when found on a provider value. */
const SECRET_FIELDS = ['apiKey', 'apiToken'] as const

/** The live llm-pi-ai entry value from the host settings service. */
export function readHostProviders(settings: SettingsFace | null): ProviderSide {
  if (!settings || typeof settings.describe !== 'function') {
    return { available: false, reason: 'settings service unavailable on this host' }
  }
  try {
    const descriptor = settings.describe().find((entry) => entry.ns === PI_AI_ENTRY)
    if (!descriptor || descriptor.value === undefined) {
      return { available: false, reason: 'no llm-pi-ai entry in the host composition' }
    }
    const value = descriptor.value as { providers?: Record<string, unknown> }
    const providers = value.providers
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
      return { available: false, reason: 'llm-pi-ai entry carries no providers map' }
    }
    return { available: true, revision: (descriptor as { revision?: number }).revision, providers }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** The engine profile patch path for the configured profile. */
export function enginePatchPath(config: ResolvedConsoleConfig): string {
  return path.join(profileDir(config.profileName), 'cordis.patch.yml')
}

/** The llm-pi-ai providers map as the engine profile patch currently holds it. */
export function readEngineProviders(patchPath: string): ProviderSide {
  let text: string
  try {
    text = fs.readFileSync(patchPath, 'utf8')
  } catch {
    return { available: false, reason: 'engine profile patch not found (engine not installed?)', patchPath }
  }
  try {
    const document = parseYaml(text)
    if (!Array.isArray(document)) return { available: false, reason: 'engine patch is not an entry list', patchPath }
    const entry = document.find((item) => item && typeof item === 'object' && (item as { id?: string }).id === PI_AI_ENTRY) as
      | { config?: { providers?: Record<string, unknown> } }
      | undefined
    const providers = entry?.config?.providers
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
      return { available: true, providers: {}, patchPath }
    }
    return { available: true, providers, patchPath }
  } catch (error) {
    return { available: false, reason: 'engine patch does not parse as YAML: ' + (error instanceof Error ? error.message : String(error)), patchPath }
  }
}

/** JSON with recursively sorted keys, so equal configs compare equal. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return '{' + entries.map(([key, item]) => JSON.stringify(key) + ':' + stableStringify(item)).join(',') + '}'
  }
  return JSON.stringify(value)
}

/** Structure diff between the two provider maps. */
export function diffProviders(host: Record<string, unknown>, engine: Record<string, unknown>): ProviderDiff {
  const added: string[] = []
  const changed: string[] = []
  const removed: string[] = []
  const unchanged: string[] = []
  for (const [id, value] of Object.entries(host)) {
    if (!(id in engine)) added.push(id)
    else if (stableStringify(value) !== stableStringify(engine[id])) changed.push(id)
    else unchanged.push(id)
  }
  for (const id of Object.keys(engine)) if (!(id in host)) removed.push(id)
  const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return { added: added.sort(byId), changed: changed.sort(byId), removed: removed.sort(byId), unchanged: unchanged.sort(byId) }
}

/** Whether a provider value carries a plaintext secret field; references do not. */
function findPlaintextSecret(value: unknown, depth = 0): string | null {
  if (depth > 3 || !value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPlaintextSecret(item, depth + 1)
      if (found) return found
    }
    return null
  }
  const record = value as Record<string, unknown>
  for (const field of SECRET_FIELDS) {
    const candidate = record[field]
    if (typeof candidate === 'string' && candidate.length > 0) return field
  }
  for (const item of Object.values(record)) {
    const found = findPlaintextSecret(item, depth + 1)
    if (found) return found
  }
  return null
}

/** A wire summary of one provider; values of identity fields only, never secrets. */
export function summarizeProvider(id: string, value: unknown): { id: string } & ProviderSummary {
  const record = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const models = Array.isArray(record.models) ? record.models : []
  return {
    id,
    displayName: typeof record.displayName === 'string' ? record.displayName : undefined,
    api: typeof record.api === 'string' ? record.api : undefined,
    baseURL: typeof record.baseURL === 'string' ? record.baseURL : undefined,
    apiKeyEnv: typeof record.apiKeyEnv === 'string' ? record.apiKeyEnv : undefined,
    modelCount: models.length,
    fieldNames: Object.keys(record),
  }
}

function safeKey(id: string): string {
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : stringifyYaml(id).trim()
}

/** Serialize one provider value as a block indented under its key. */
function providerBlock(id: string, value: unknown, keyIndent: number): string {
  const body = stringifyYaml(value as never, { lineWidth: 0 })
  const pad = ' '.repeat(keyIndent)
  const inner = ' '.repeat(keyIndent + 2)
  const lines = body.split('\n').map((line) => (line.length > 0 ? inner + line : line))
  return pad + safeKey(id) + ':\n' + lines.join('\n')
}

/** The full llm-pi-ai entry text (mirror target), comment line included. */
function entryBlock(providers: Record<string, unknown>, stamp: string): string[] {
  const lines: string[] = [
    '# llm-pi-ai providers maintained by dsh-superagent-console (mode=mirror, ' + stamp + ');',
    '# manual edits inside this entry are overwritten on the next mirror sync.',
    '- id: ' + PI_AI_ENTRY,
    '  name: "' + PI_AI_BUNDLE + '"',
    '  config:',
    '    providers:',
  ]
  for (const [id, value] of Object.entries(providers)) {
    const block = providerBlock(id, value, 6)
    lines.push(...block.split('\n'))
  }
  if (Object.keys(providers).length === 0) lines[lines.length - 1] = '    providers: {}'
  return lines
}

/** Index of the top-level entry with the given id, or -1. */
function findEntry(lines: string[], entryId: string): number {
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === '- id: ' + entryId) return index
  }
  return -1
}

/** End (exclusive) of the entry starting at start: the next unindented list item or EOF. */
function entryEnd(lines: string[], start: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line !== undefined && /^- /.test(line)) return index
  }
  return lines.length
}

/**
 * Merge-mode surgery: append the missing providers under the existing
 * entry's providers map (creating the map when absent, creating the whole
 * entry when absent). Existing text outside the inserted lines stays put.
 */
function mergePatchText(original: string, additions: Record<string, unknown>, stamp: string): string {
  const lines = original.split('\n')
  const comment = '# dsh-superagent-console provider-sync: appended providers (mode=merge, ' + stamp + ')'
  let entryStart = findEntry(lines, PI_AI_ENTRY)

  if (entryStart < 0) {
    const fresh = [
      comment,
      '- id: ' + PI_AI_ENTRY,
      '  name: "' + PI_AI_BUNDLE + '"',
      '  config:',
      '    providers:',
    ]
    for (const [id, value] of Object.entries(additions)) fresh.push(...providerBlock(id, value, 6).split('\n'))
    const trimmed = original.replace(/\n+$/, '')
    return trimmed + '\n\n' + fresh.join('\n') + '\n'
  }

  const end = entryEnd(lines, entryStart)
  let providersLine = -1
  for (let index = entryStart; index < end; index += 1) {
    if (lines[index] === '    providers:') providersLine = index
  }

  const blocks: string[] = []
  for (const [id, value] of Object.entries(additions)) blocks.push(...providerBlock(id, value, 6).split('\n'))

  if (providersLine >= 0) {
    // Empty map form first.
    if (lines[providersLine] === '    providers:' && (lines[providersLine + 1] === undefined || lines[providersLine + 1] === '    providers: {}')) {
      let insertAt = providersLine + 1
      if (lines[insertAt] === '    providers: {}') insertAt += 1
      lines.splice(providersLine, insertAt - providersLine, '    providers:', ...blocks)
    } else {
      let insertAt = providersLine + 1
      while (insertAt < end && (lines[insertAt] ?? '').startsWith('      ')) insertAt += 1
      lines.splice(insertAt, 0, ...blocks)
    }
    return lines.join('\n')
  }

  // Entry exists but has no providers key: find its config: line (or add one).
  let configLine = -1
  for (let index = entryStart; index < end; index += 1) {
    if (lines[index] === '  config:') configLine = index
  }
  if (configLine >= 0) {
    lines.splice(configLine + 1, 0, '    providers:', ...blocks)
    return lines.join('\n')
  }
  const rebuilt = [
    lines[entryStart] ?? ('- id: ' + PI_AI_ENTRY),
    '  name: "' + PI_AI_BUNDLE + '"',
    '  config:',
    '    providers:',
    ...blocks,
  ]
  lines.splice(entryStart, end - entryStart, ...rebuilt)
  return lines.join('\n')
}

/** Mirror-mode surgery: replace the whole entry (or append a fresh one). */
function mirrorPatchText(original: string, providers: Record<string, unknown>, stamp: string): string {
  const lines = original.split('\n')
  const entryStart = findEntry(lines, PI_AI_ENTRY)
  const block = entryBlock(providers, stamp)
  if (entryStart < 0) {
    const trimmed = original.replace(/\n+$/, '')
    return trimmed + '\n\n' + block.join('\n') + '\n'
  }
  const end = entryEnd(lines, entryStart)
  lines.splice(entryStart, end - entryStart, ...block)
  return lines.join('\n')
}

/** Parse the candidate text and require the llm-pi-ai entry to hold a providers map. */
function validatePatchText(text: string): void {
  const document = parseYaml(text) as unknown
  if (!Array.isArray(document)) throw new Error('patch validation failed: result is not an entry list')
  const entry = document.find((item) => item && typeof item === 'object' && (item as { id?: string }).id === PI_AI_ENTRY) as
    | { config?: { providers?: Record<string, unknown> } }
    | undefined
  if (!entry) throw new Error('patch validation failed: llm-pi-ai entry missing after edit')
  const providers = entry.config?.providers
  if (providers !== undefined && (typeof providers !== 'object' || Array.isArray(providers))) {
    throw new Error('patch validation failed: providers is not a map after edit')
  }
}

/** Keep the newest N sync backups, remove older ones. */
function pruneBackups(patchPath: string, keep: number): void {
  const dir = path.dirname(patchPath)
  const base = path.basename(patchPath)
  const prefix = base + '.bak-sync-'
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).sort()
  for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
    try { fs.unlinkSync(path.join(dir, name)) } catch { /* best effort */ }
  }
}

/** Filename-safe timestamp for backup suffixes. */
function stampOf(now = new Date()): string {
  return now.toISOString().replace(/:/g, '-')
}

/**
 * Plan and apply one provider sync. Reads the host live providers and the
 * engine patch, computes the write, and performs the guarded file surgery.
 * Throws with a readable message when either side is unavailable; the file
 * is only touched when the plan actually changes bytes.
 */
export async function applyProviderSync(
  config: ResolvedConsoleConfig,
  settings: SettingsFace | null,
  options: { mode?: SyncMode; exclude?: string[] } = {},
): Promise<SyncReport> {
  const mode = options.mode ?? 'merge'
  const exclude = new Set(options.exclude ?? [])
  const host = readHostProviders(settings)
  if (!host.available || !host.providers) throw new Error(host.reason ?? 'host providers unavailable')
  const patchPath = enginePatchPath(config)
  const engine = readEngineProviders(patchPath)
  if (!engine.available) throw new Error(engine.reason ?? 'engine providers unavailable')

  const skipped: SyncReport['skipped'] = []
  const warnings: string[] = []
  const cleanHost: Record<string, unknown> = {}
  for (const [id, value] of Object.entries(host.providers)) {
    if (exclude.has(id)) continue
    const secret = findPlaintextSecret(value)
    if (secret) {
      skipped.push({ id, reason: 'carries a plaintext "' + secret + '" field; secret values are never copied' })
      warnings.push('skipped provider "' + id + '": plaintext secret field "' + secret + '"')
      continue
    }
    cleanHost[id] = value
  }

  const before = diffProviders(host.providers, engine.providers ?? {})
  const original = fs.readFileSync(patchPath, 'utf8')
  const stamp = stampOf()
  let nextText: string
  const added: string[] = []
  const removed: string[] = []
  const keptExcluded = Object.keys(engine.providers ?? {}).filter((id) => exclude.has(id))

  if (mode === 'mirror') {
    const target: Record<string, unknown> = { ...cleanHost }
    for (const id of keptExcluded) target[id] = (engine.providers ?? {})[id]
    for (const id of Object.keys(target)) if (!(id in (engine.providers ?? {}))) added.push(id)
    for (const id of Object.keys(engine.providers ?? {})) if (!(id in target)) removed.push(id)
    nextText = mirrorPatchText(original, target, stamp)
  } else {
    const current = { ...(engine.providers ?? {}) }
    for (const id of before.added) {
      if (exclude.has(id) || !cleanHost[id]) continue
      current[id] = cleanHost[id]
      added.push(id)
    }
    nextText = mergePatchText(original, Object.fromEntries(added.map((id) => [id, cleanHost[id]])), stamp)
  }

  if (nextText === original) {
    return {
      mode, changedFile: false, added: [], changed: before.changed, removed: [],
      skipped, warnings, engineProviders: Object.keys(engine.providers ?? {}),
      hotReload: 'verified', needsRestart: false,
    }
  }

  validatePatchText(nextText)
  const backupPath = patchPath + '.bak-sync-' + stamp
  fs.copyFileSync(patchPath, backupPath)
  const tmpPath = patchPath + '.tmp-sync-' + String(process.pid)
  fs.writeFileSync(tmpPath, nextText)
  try {
    validatePatchText(fs.readFileSync(tmpPath, 'utf8'))
    fs.renameSync(tmpPath, patchPath)
  } catch (error) {
    try { fs.unlinkSync(tmpPath) } catch { /* already gone */ }
    throw error
  }
  pruneBackups(patchPath, 5)

  const after = readEngineProviders(patchPath)
  const engineProviders = after.providers ? Object.keys(after.providers) : []
  // The running engine watches its profile patch and hot-reloads llm-pi-ai;
  // wait for the catalog to reflect the write instead of demanding a restart.
  // An offline engine needs nothing — the change applies at next start.
  const hotReload = await awaitHotReload(config.target, engineProviders)
  return {
    mode,
    changedFile: true,
    backupPath,
    added,
    changed: before.changed,
    removed,
    skipped,
    warnings,
    engineProviders,
    hotReload,
    needsRestart: hotReload === 'timeout',
  }
}
