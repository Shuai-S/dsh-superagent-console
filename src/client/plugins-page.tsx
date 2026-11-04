/**
 * Plugins tab for the official panel: manage the engine profile's plugin
 * dependencies — roster with bundle/enable state, guarded install and
 * remove, and bundle selection toggles. Rendered from the vendored App
 * through the seams scripts/sync-client.mjs applies after each vendor sync.
 *
 * All state comes from the console API (/superagent-console/api/plugins*),
 * never from the engine proxy: mutations touch the profile on disk and are
 * served by the same guards as the installer (single-flight, argv-only
 * spawns, protected engine core). Rows poll at the panel's usual cadence
 * and speed up while an operation runs.
 */
import { useState, type FormEvent } from 'react'
import { usePoll } from '../vendor/client/api.ts'
import { Button, Dot, Icon, Input, Switch, Tag } from '../vendor/client/controls.tsx'
import { useAction, usePanel } from '../vendor/client/provider.tsx'
import { ConfirmButton, Hint, LoadState, Section } from '../vendor/client/widgets.tsx'

export interface PluginRow {
  name: string
  spec: string
  version: string | null
  description: string | null
  bundle: boolean
  enabled: boolean
  protectedCore: boolean
}

export interface PluginOperation {
  running: boolean
  kind: 'install' | 'remove' | null
  target: string | null
  exitCode: number | null
  timedOut: boolean
  output: string
  error: string | null
}

export interface PluginsPayload {
  profileName: string
  profileDir: string
  profileInstalled: boolean
  rows: PluginRow[]
  operation: PluginOperation
}

async function consoleApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = (payload as { error?: string }).error ?? `HTTP ${response.status}`
    throw new Error(message)
  }
  return payload as T
}

const post = (path: string, body: unknown): Promise<unknown> => consoleApi(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

function PluginItem({ row, busy, onRemove, onToggle }: {
  row: PluginRow
  busy: boolean
  onRemove: (name: string) => Promise<unknown>
  onToggle: (name: string, enabled: boolean) => Promise<unknown>
}): React.JSX.Element {
  const { t } = usePanel()
  return <li className="dt-row">
    <Dot state={row.protectedCore ? 'done' : row.bundle ? (row.enabled ? 'done' : 'warning') : 'idle'}
      label={row.bundle ? (row.enabled ? t('plugins.disable') : t('plugins.enable')) : undefined} />
    <div className="dt-row-main">
      <div className="dt-row-title">
        <span className="dt-row-name">{row.name}</span>
        {row.version && <span className="dt-status-text">{row.version}</span>}
        {row.protectedCore && <Tag tone="info">{t('plugins.protected')}</Tag>}
        {!row.bundle && <Tag tone="neutral" title={t('plugins.notBundle')}>{t('plugins.dependencyTag')}</Tag>}
      </div>
      <div className="dt-row-meta">
        {row.description && <span className="dt-ellipsis">{row.description}</span>}
        <code className="dt-code">{row.spec}</code>
      </div>
    </div>
    <div className="dt-row-actions">
      {row.bundle && !row.protectedCore && <span style={{ opacity: busy ? 0.45 : undefined }}>
        <Switch checked={row.enabled} onChange={next => { if (!busy) void onToggle(row.name, next) }}
          label={row.enabled ? t('plugins.disable') : t('plugins.enable')} />
      </span>}
      {!row.protectedCore && <ConfirmButton label={t('plugins.remove')} title={t('plugins.removeTitle')}
        message={t('plugins.removeConfirm', { name: row.name })} icon="trash" variant="ghost"
        onConfirm={() => onRemove(row.name)} />}
    </div>
  </li>
}

/** The plugins roster page, mounted by the vendored panel's route switch. */
export function PluginsPage(): React.JSX.Element {
  const { t } = usePanel()
  const [spec, setSpec] = useState('')
  // Fixed 3s cadence: quick enough to track an install, cheap enough to poll always.
  const { data, error, reload } = usePoll<PluginsPayload>(
    () => consoleApi<PluginsPayload>('/superagent-console/api/plugins'), [], 3000)
  const rows = data?.rows ?? []
  const op = data?.operation
  const opRunning = op?.running === true

  const install = useAction(async () => {
    await post('/superagent-console/api/plugins/install', { spec: spec.trim() })
    setSpec('')
  }, { reload })
  const mutate = useAction(async (path: string, body: unknown) => { await post(path, body) }, { reload })
  const restart = useAction(async () => { await post('/superagent-console/api/engine/restart', {}) }, { reload })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (spec.trim() && !opRunning) void install.run()
  }

  return <div className="dt-form">
    <Section title={t('tab.plugins')} count={rows.length} hint={t('plugins.hint')} icon="queue">
      <form className="dt-row-buttons" onSubmit={submit}>
        <Input type="text" value={spec} placeholder={t('plugins.specPlaceholder')} aria-label={t('plugins.installLabel')}
          style={{ width: 'min(420px, 60vw)' }} disabled={opRunning}
          onChange={event => { setSpec(event.target.value) }} />
        <Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />}
          disabled={opRunning || install.busy || !spec.trim()} onClick={() => { void install.run() }}>
          {install.busy ? t('plugins.installing') : t('plugins.installLabel')}
        </Button>
      </form>
      {op && (op.running || op.kind !== null) && <div className="dt-block">
        <div className="dt-row">
          <Dot state={op.running ? 'ongoing' : op.error ? 'error' : 'done'} />
          <div className="dt-row-main">
            <div className="dt-row-title">
              {op.running
                ? op.kind === 'install' ? t('plugins.opInstallRunning', { target: op.target ?? '' }) : t('plugins.opRemoveRunning', { target: op.target ?? '' })
                : op.error ? t('plugins.opFailed', { error: op.error }) : t('plugins.restartHint')}
            </div>
            {op.output && <pre className="dt-pre" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{op.output}</pre>}
            {!op.running && !op.error && op.kind !== null && <div className="dt-row-meta">
              <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />}
                disabled={restart.busy} onClick={() => { void restart.run() }}>
                {restart.busy ? t('plugins.restarting') : t('plugins.restart')}
              </Button>
            </div>}
          </div>
        </div>
      </div>}
      <LoadState error={error} loading={!data} />
      {data !== undefined && rows.length === 0 && <Hint>{t('plugins.empty')}</Hint>}
      {rows.length > 0 && <ul className="dt-list">
        {rows.map(row => <PluginItem key={row.name} row={row} busy={opRunning}
          onRemove={async name => { await mutate.run('/superagent-console/api/plugins/remove', { name }) }}
          onToggle={async (name, enabled) => { await mutate.run('/superagent-console/api/plugins/enable', { name, enabled }) }} />)}
      </ul>}
      {data?.profileInstalled && <Hint><code className="dt-code">{data.profileDir}</code></Hint>}
    </Section>
  </div>
}
