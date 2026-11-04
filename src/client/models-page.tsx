/**
 * Models settings group for the official panel: keep the engine profile's
 * llm-pi-ai providers in step with this host's live provider map. Data comes
 * from the console API (/superagent-console/api/providers*) — the sync itself
 * runs server-side through the guarded provider-sync module (mirror/merge,
 * backup, atomic write, plaintext-secret guard). Rendered from the vendored
 * SettingsPage through the seams scripts/sync-client.mjs applies after each
 * vendor sync; dictionaries ride the same locales.ts seam.
 */
import { useState } from 'react'
import { usePoll } from '../vendor/client/api.ts'
import { Button, Dot, SegmentedTabs, Tag } from '../vendor/client/controls.tsx'
import { usePanel } from '../vendor/client/provider.tsx'
import { Hint, KeyValues, Section } from '../vendor/client/widgets.tsx'

export interface ProviderWire {
  id: string
  displayName?: string
  api?: string
  baseURL?: string
  apiKeyEnv?: string
  modelCount: number
  fields: string[]
}

export interface ProviderSideWire {
  available: boolean
  reason?: string
  revision?: number
  patchPath?: string
  providers?: ProviderWire[]
}

export interface ProviderDiffWire {
  added: string[]
  changed: string[]
  removed: string[]
  unchanged: string[]
}

export interface SyncReportWire {
  mode: string
  changedFile: boolean
  backupPath?: string
  added: string[]
  removed: string[]
  skipped: Array<{ id: string; reason: string }>
  warnings: string[]
  hotReload: 'verified' | 'offline' | 'timeout'
  needsRestart: boolean
}

export interface ProvidersPayload {
  source: ProviderSideWire
  engine: ProviderSideWire
  diff: ProviderDiffWire | null
  sync: {
    mode: 'merge' | 'mirror'
    exclude: string[]
    autoSync: boolean
    busy: boolean
    lastReport: SyncReportWire | null
    lastError: string | null
  }
}

async function consoleApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const record = payload as { error?: string; output?: string; exit?: number }
    // Action failures carry their real cause in output/exit (engine restart 502), not in error.
    const detail = record.output?.trim()
    const message = record.error ?? `HTTP ${response.status}`
    throw new Error(detail ? `${message} (exit ${record.exit ?? '?'}): ${detail}` : message)
  }
  return payload as T
}

function DiffGroup({ title, ids, tone }: { title: string; ids: string[]; tone?: 'info' | 'neutral' }): React.JSX.Element | null {
  if (ids.length === 0) return null
  return <div className="dt-block">
    <div className="dt-row-title">{title} <span style={{ opacity: 0.6 }}>({ids.length})</span></div>
    <div className="dt-row-buttons" style={{ flexWrap: 'wrap', gap: 6 }}>
      {ids.map(id => <Tag key={id} tone={tone}>{id}</Tag>)}
    </div>
  </div>
}

/** The whole models group body: two-side state, diff, mode picker, sync, report. */
export function ModelsPage(): React.JSX.Element {
  const { t } = usePanel()
  const { data, error, reload } = usePoll<ProvidersPayload>(
    () => consoleApi('/superagent-console/api/providers'), [], 8000)
  const [mode, setMode] = useState<'merge' | 'mirror' | null>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<SyncReportWire | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)

  const activeMode = mode ?? data?.sync.mode ?? 'merge'
  const diff = data?.diff
  const diverging = diff ? diff.added.length + diff.changed.length + diff.removed.length : 0

  const sideCount = (side: ProviderSideWire | undefined): string => {
    if (!side?.available) return t('providerSync.unavailable')
    return String(side.providers?.length ?? 0)
  }

  const runSync = async (): Promise<void> => {
    setBusy(true)
    setActionError(null)
    try {
      const payload = await consoleApi<{ report: SyncReportWire }>('/superagent-console/api/providers/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: activeMode }),
      })
      setReport(payload.report)
      await reload()
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const restart = async (): Promise<void> => {
    setRestarting(true)
    setActionError(null)
    try {
      await consoleApi('/superagent-console/api/engine/restart', { method: 'POST' })
      await reload()
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setRestarting(false)
    }
  }

  return <div className="dt-form">
    <Section title={t('providerSync.title')} hint={t('providerSync.hint')}>
      <LoadError error={error} actionError={actionError ?? data?.sync.lastError ?? null} />
      {data && <div className="dt-block">
        <KeyValues rows={[
          [t('providerSync.source'), sideCount(data.source)],
          [t('providerSync.engine'), sideCount(data.engine)],
        ]} />
        {data.sync.autoSync && <div className="dt-row" style={{ marginTop: 6 }}>
          <Dot state="done" />
          <span className="dt-row-title">{t('providerSync.autoOn')}</span>
        </div>}
        {!data.source.available && <Hint>{t('providerSync.sourceMissing')}</Hint>}
        {!data.engine.available && <Hint>{t('providerSync.engineMissing', { reason: data.engine.reason ?? '' })}</Hint>}
      </div>}
    </Section>

    {data?.source.available && data.engine.available && diff && (
      <Section title={t('providerSync.diffTitle')} count={diverging || undefined}>
        {diverging === 0
          ? <Hint>{t('providerSync.noDiff')}</Hint>
          : <div>
              <DiffGroup title={t('providerSync.added')} ids={diff.added} tone="info" />
              <DiffGroup title={t('providerSync.changed')} ids={diff.changed} />
              <DiffGroup title={t('providerSync.removed')} ids={diff.removed} tone="neutral" />
            </div>}
      </Section>
    )}

    {data?.source.available && data.engine.available && (
      <Section title={t('providerSync.mode')}>
        <SegmentedTabs<'merge' | 'mirror'>
          label={t('providerSync.mode')}
          items={[
            { value: 'merge', label: t('providerSync.mode.merge'), id: 'sync-mode-merge', panelId: 'sync-mode-merge-panel' },
            { value: 'mirror', label: t('providerSync.mode.mirror'), id: 'sync-mode-mirror', panelId: 'sync-mode-mirror-panel' },
          ]}
          value={activeMode}
          onChange={next => { setMode(next) }}
        />
        <Hint>{t('providerSync.modeHint')}</Hint>
        {data.sync.exclude.length > 0 && <Hint>{t('providerSync.exclude', { ids: data.sync.exclude.join(', ') })}</Hint>}
        <div className="dt-row-buttons">
          <Button variant="primary" size="sm"
            disabled={busy || diverging === 0}
            onClick={() => { void runSync() }}>
            {busy ? t('providerSync.doing') : t('providerSync.do')}
          </Button>
        </div>
        {report && <div className="dt-block" style={{ marginTop: 10 }}>
          <div className="dt-row">
            <Dot state={report.changedFile ? 'done' : 'idle'} />
            <div className="dt-row-main">
              <div className="dt-row-title">{t('providerSync.done', { mode: report.mode === 'merge' || report.mode === 'mirror' ? t(`providerSync.mode.${report.mode}`) : report.mode })}</div>
              {report.backupPath && <div className="dt-row-meta">{t('providerSync.backup', { path: report.backupPath })}</div>}
              {report.skipped.map(item => (
                <div key={item.id} className="dt-row-meta">
                  {t('providerSync.skipped', { id: item.id, reason: item.reason })}
                </div>
              ))}
              {report.hotReload === 'verified' && <div className="dt-row-meta" style={{ color: 'var(--dt-ok, #2e9e5b)' }}>{t('providerSync.hotVerified')}</div>}
              {report.hotReload === 'offline' && <div className="dt-row-meta">{t('providerSync.hotOffline')}</div>}
              {report.needsRestart && <div className="dt-row-meta">
                {t('providerSync.hotTimeout')}
                <Button variant="outline" size="sm" style={{ marginLeft: 8 }}
                  disabled={restarting} onClick={() => { void restart() }}>
                  {restarting ? t('providerSync.restarting') : t('providerSync.restart')}
                </Button>
              </div>}
            </div>
          </div>
        </div>}
      </Section>
    )}
  </div>
}

/** Combined load/action error line; keeps the panel's own error styling. */
function LoadError({ error, actionError }: { error?: Error; actionError: string | null }): React.JSX.Element | null {
  if (!error && !actionError) return null
  return <p className="dt-error" role="alert">{error?.message ?? actionError}</p>
}
