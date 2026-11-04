/**
 * Gated console panel: poll the console status API and either mount the
 * official panel (engine running) or a self-styled setup card with the one
 * action each state maps to — install / start / restart. The card styles
 * itself inline because the official stylesheet only loads with the panel.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession, SessionNavigationError } from '../vendor/navigation.ts'
import { App } from '../vendor/client/app.tsx'
import { usePageForm } from '../vendor/client/deployment.tsx'
import type { T } from '../vendor/client/text.ts'
import type { SetupT } from './setup-locale.ts'

export type ClientContext = Context & { sessions: ISessions }

interface Prereq {
  name: string
  ok: boolean
  detail: string
}

interface Health {
  exit: number
  pids: number[]
  url: string | null
  manuallyStopped: boolean
  health: Record<string, string> | null
  errors: Record<string, string> | null
  setup: string | null
}

interface Stage {
  status: string
  detail?: string
}

interface Setup {
  running: boolean
  current: string | null
  stages: Record<string, Stage>
  error: string | null
}

interface Status {
  state: 'running' | 'installed-stopped' | 'installed-unhealthy' | 'not-installed' | 'prereq-missing'
  target: string
  engineReachable: boolean
  profileInstalled: boolean
  patchMissing: boolean
  checkoutValid: boolean
  health: Health | null
  prereqs: Prereq[]
  installRunning: boolean
  setup: Setup
}

const STAGES = ['prereqs', 'checkout', 'build', 'profile', 'plugin', 'patch', 'start', 'verify'] as const

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = (payload as { error?: string }).error ?? `HTTP ${response.status}`
    throw new Error(message)
  }
  return payload as T
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const cardStyle: CSSProperties = {
  maxWidth: 640,
  margin: '48px auto',
  padding: '24px 28px',
  borderRadius: 12,
  border: '1px solid var(--dsh-border, rgba(128,128,128,.25))',
  fontFamily: 'inherit',
  fontSize: 14,
  lineHeight: 1.6,
}

const buttonStyle: CSSProperties = {
  padding: '7px 18px',
  borderRadius: 8,
  border: '1px solid transparent',
  cursor: 'pointer',
  fontSize: 14,
}

const monoStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  wordBreak: 'break-all',
}

function Button(props: { label: string; primary?: boolean; disabled?: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        ...buttonStyle,
        background: props.primary ? 'var(--dsh-primary, #4c6fff)' : 'transparent',
        color: props.primary ? '#fff' : 'inherit',
        borderColor: props.primary ? 'transparent' : 'var(--dsh-border, rgba(128,128,128,.4))',
        opacity: props.disabled ? 0.55 : 1,
      }}
    >
      {props.label}
    </button>
  )
}

// --- Provider sync card -------------------------------------------------

interface ProviderWire {
  id: string
  displayName?: string
  api?: string
  baseURL?: string
  apiKeyEnv?: string
  modelCount: number
  fields: string[]
}

interface ProviderSideWire {
  available: boolean
  reason?: string
  patchPath?: string
  providers?: ProviderWire[]
}

interface ProviderDiffWire {
  added: string[]
  changed: string[]
  removed: string[]
  unchanged: string[]
}

interface SyncReportWire {
  mode: string
  changedFile: boolean
  backupPath?: string
  added: string[]
  removed: string[]
  skipped: Array<{ id: string; reason: string }>
  warnings: string[]
  needsRestart: boolean
}

interface ProvidersPayload {
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

function ProviderChip({ id, hint }: { id: string; hint?: string }): React.JSX.Element {
  return (
    <span style={{ ...monoStyle, display: 'inline-block', padding: '1px 8px', margin: '2px 4px 2px 0', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.3))' }}>
      {id}
      {hint && <span style={{ opacity: 0.6 }}> · {hint}</span>}
    </span>
  )
}

function DiffGroup({ title, ids, tone }: { title: string; ids: string[]; tone?: string }): React.JSX.Element | null {
  if (ids.length === 0) return null
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontWeight: 600, color: tone }}>{title} <span style={{ opacity: 0.6 }}>({ids.length})</span></div>
      <div>{ids.map((id) => <ProviderChip key={id} id={id} />)}</div>
    </div>
  )
}

/**
 * Collapsible provider-sync card: polls the console providers API, shows the
 * host/engine diff, and runs the guarded sync into the engine profile patch.
 * Rendered above the panel or setup card; collapsed by default so it never
 * crowds the official panel.
 */
function ProviderSyncCard({ st }: { st: SetupT }): React.JSX.Element {
  const [data, setData] = useState<ProvidersPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'merge' | 'mirror'>('merge')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<SyncReportWire | null>(null)

  const refresh = useCallback(async () => {
    try {
      const payload = await api<ProvidersPayload>('/superagent-console/api/providers')
      setData(payload)
      setError(null)
    } catch (caught) {
      setError(messageOf(caught))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 8000)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    if (data && !busy) setMode(data.sync.mode)
    // Only adopt the configured mode when idle, never mid-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.sync.mode])

  const diff = data?.diff
  const diverging = diff ? diff.added.length + diff.changed.length + diff.removed.length : 0

  const runSync = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const payload = await api<{ report: SyncReportWire }>('/superagent-console/api/providers/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      setReport(payload.report)
      await refresh()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }, [mode, refresh])

  const restart = useCallback(async () => {
    setBusy(true)
    try {
      await api('/superagent-console/api/engine/restart', { method: 'POST' })
      await refresh()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const sideLabel = (side: ProviderSideWire | undefined): string => {
    if (!side) return st('syncUnavailable')
    if (!side.available) return st('syncUnavailable')
    const count = side.providers?.length ?? 0
    return `${count}`
  }

  const modeButton = (value: 'merge' | 'mirror', label: string): React.JSX.Element => (
    <button
      type="button"
      onClick={() => { setMode(value) }}
      style={{
        ...buttonStyle,
        borderColor: mode === value ? 'var(--dsh-primary, #4c6fff)' : 'var(--dsh-border, rgba(128,128,128,.4))',
        color: mode === value ? 'var(--dsh-primary, #4c6fff)' : 'inherit',
        fontWeight: mode === value ? 600 : 400,
      }}
    >
      {label}
    </button>
  )

  return (
    <div style={{ ...cardStyle, margin: '16px auto 0', padding: '14px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => { setOpen(!open) }}>
        <span style={{ fontWeight: 600 }}>{st('syncTitle')}</span>
        {data?.sync.autoSync && <span style={{ ...monoStyle, opacity: 0.7, color: 'var(--dsh-ok, #2e9e5b)' }}>{st('syncAutoOn')}</span>}
        <span style={{ opacity: 0.65 }}>{diverging > 0 ? `${diverging}` : ''}</span>
        <span style={{ marginLeft: 'auto', opacity: 0.6 }}>{open ? '▾' : '▸'}</span>
      </div>

      {error && <div style={{ color: 'var(--dsh-danger, #d64545)', marginTop: 8 }}>{error}</div>}

      {open && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', opacity: 0.85 }}>
            <span>{st('syncSource')}: {sideLabel(data?.source)}</span>
            <span>{st('syncEngine')}: {sideLabel(data?.engine)}</span>
          </div>

          {!data?.source.available && <div style={{ opacity: 0.7, marginTop: 6 }}>{st('syncSourceMissing')}</div>}
          {data && !data.engine.available && (
            <div style={{ opacity: 0.7, marginTop: 6 }}>{st('syncEngineMissing')}{data.engine.reason ?? ''}</div>
          )}

          {diff && diverging === 0 && <div style={{ opacity: 0.7, marginTop: 8 }}>{st('syncNoDiff')}</div>}
          {diff && diverging > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ fontWeight: 600, marginTop: 8 }}>{st('syncDiff')}</div>
              <DiffGroup title={st('syncAdded')} ids={diff.added} tone="var(--dsh-ok, #2e9e5b)" />
              <DiffGroup title={st('syncChanged')} ids={diff.changed} tone="var(--dsh-warning, #c98a1b)" />
              <DiffGroup title={st('syncRemoved')} ids={diff.removed} />
            </div>
          )}

          {data?.source.available && data.engine.available && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 600 }}>{st('syncModeLabel')}</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                {modeButton('merge', st('syncModeMerge'))}
                {modeButton('mirror', st('syncModeMirror'))}
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button primary disabled={busy || diverging === 0} label={busy ? st('syncDoing') : st('syncDo')} onClick={() => { void runSync() }} />
                {data.sync.exclude.length > 0 && <span style={{ ...monoStyle, opacity: 0.6 }}>exclude: {data.sync.exclude.join(', ')}</span>}
              </div>
            </div>
          )}

          {report && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--dsh-border, rgba(128,128,128,.25))', paddingTop: 10 }}>
              <div style={{ fontWeight: 600 }}>{st('syncDone')} <span style={{ opacity: 0.6 }}>({report.mode})</span></div>
              {report.added.length > 0 && <div style={{ marginTop: 4 }}>{st('syncAdded')}: {report.added.join(', ')}</div>}
              {report.removed.length > 0 && <div style={{ marginTop: 4 }}>{st('syncRemoved')}: {report.removed.join(', ')}</div>}
              {report.skipped.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  {st('syncSkipped')}:
                  {report.skipped.map((item) => (
                    <div key={item.id} style={{ ...monoStyle, opacity: 0.75, marginLeft: 10 }}>{item.id} — {item.reason}</div>
                  ))}
                </div>
              )}
              {report.backupPath && <div style={{ ...monoStyle, opacity: 0.6, marginTop: 4 }}>{st('syncBackup')}: {report.backupPath}</div>}
              {report.needsRestart && (
                <div style={{ marginTop: 8, display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span style={{ opacity: 0.85 }}>{st('syncRestartHint')}</span>
                  <Button label={busy ? st('restarting') : st('syncRestartPending')} disabled={busy} onClick={() => { void restart() }} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PrereqList({ prereqs, title }: { prereqs: Prereq[]; title: string }): React.JSX.Element {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 600 }}>{title}</div>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {prereqs.map((item) => (
          <li key={item.name} style={{ color: item.ok ? 'inherit' : 'var(--dsh-danger, #d64545)' }}>
            <code style={monoStyle}>{item.name}</code>
            <span style={{ opacity: 0.75 }}> — {item.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function StageList({ setup, st }: { setup: Setup; st: SetupT }): React.JSX.Element {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 600 }}>{st('stageTitle')}</div>
      <ol style={{ margin: '6px 0 0', paddingLeft: 18 }}>
        {STAGES.map((id) => {
          const stage = setup.stages[id]
          const status = stage?.status ?? 'pending'
          const mark = status === 'done' ? '✓' : status === 'failed' ? '✗' : status === 'running' ? '…' : status === 'skipped' ? '–' : '·'
          const color = status === 'done' ? 'var(--dsh-ok, #2e9e5b)' : status === 'failed' ? 'var(--dsh-danger, #d64545)' : 'inherit'
          return (
            <li key={id} style={{ color }}>
              <code style={monoStyle}>{id}</code> <span style={{ opacity: 0.75 }}>{mark} {status}</span>
              {stage?.detail && <div style={{ ...monoStyle, opacity: 0.7, whiteSpace: 'pre-wrap', marginLeft: 12 }}>{stage.detail}</div>}
            </li>
          )
        })}
      </ol>
      {setup.error && <div style={{ color: 'var(--dsh-danger, #d64545)', marginTop: 8 }}>{st('installFailed')}: {setup.error}</div>}
    </div>
  )
}

/** Mount the official panel exactly the way the official entry does. */
function OfficialPanel({ ctx, t }: { ctx: ClientContext; t: T }): React.JSX.Element {
  const pending = useRef<AbortController>(undefined)
  useEffect(() => () => { pending.current?.abort() }, [])
  const openSession = useCallback(async (id: string) => {
    pending.current?.abort()
    const request = new AbortController()
    pending.current = request
    try {
      await openKnownSession(ctx.sessions, id as SessionId, (target) => { ctx.uiWorkspace.openSession(target) }, request.signal)
    } catch (error) {
      if (error instanceof SessionNavigationError) throw new Error(t(error.code === 'not-ready' ? 'sessionListNotReady' : 'sessionNotListed'))
      throw error
    }
  }, [ctx, t])
  const form = usePageForm(ctx.get('configForms')?.get<Record<string, unknown>>('dsh-superagent'))
  return <App t={t} openSession={openSession} deploymentForm={form} />
}

export function Gate({ ctx, t, st }: { ctx: ClientContext; t: T; st: SetupT }): React.JSX.Element {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<Status>('/superagent-console/api/status'))
      setError(null)
    } catch (caught) {
      setError(messageOf(caught))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => clearInterval(timer)
  }, [refresh])

  const act = useCallback(async (key: string, path: string) => {
    setBusy(key)
    try {
      await api(path, { method: 'POST' })
      await refresh()
    } catch (caught) {
      setError(`${st('actionFailed')}: ${messageOf(caught)}`)
    } finally {
      setBusy(null)
    }
  }, [refresh, st])

  const install = useCallback(async () => {
    setBusy('install')
    setError(null)
    try {
      await api('/superagent-console/api/install', { method: 'POST' })
      // The installer runs server-side; keep polling via the interval above.
    } catch (caught) {
      setError(`${st('actionFailed')}: ${messageOf(caught)}`)
    } finally {
      setBusy(null)
    }
  }, [st])

  if (!status) {
    return (
      <div style={cardStyle}>
        {error
          ? (
              <>
                <div style={{ color: 'var(--dsh-danger, #d64545)' }}>{st('loadFailed')}: {error}</div>
                <div style={{ marginTop: 12 }}><Button label={st('retry')} onClick={() => { void refresh() }} /></div>
              </>
            )
          : <div style={{ opacity: 0.7 }}>{st('loading')}</div>}
      </div>
    )
  }

  const installing = status.installRunning || status.setup.running
  const failed = !installing && STAGES.some((id) => status.setup.stages[id]?.status === 'failed')

  if (status.state === 'running' && !installing) {
    return (
      <div>
        <ProviderSyncCard st={st} />
        <OfficialPanel ctx={ctx} t={t} />
      </div>
    )
  }

  const headline =
    status.state === 'installed-stopped' ? st('titleStopped')
    : status.state === 'installed-unhealthy' ? st('titleUnhealthy')
    : status.state === 'prereq-missing' ? st('titlePrereq')
    : st('titleNotInstalled')
  const description =
    status.state === 'installed-stopped' ? st('descStopped')
    : status.state === 'installed-unhealthy' ? st('descUnhealthy')
    : status.state === 'prereq-missing' ? st('descPrereq')
    : st('descNotInstalled')

  const coreMissing = status.prereqs.some((item) => !item.ok)

  return (
    <div>
      <ProviderSyncCard st={st} />
      <div style={cardStyle}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{headline}</h2>
      <p style={{ opacity: 0.85, margin: '8px 0 0' }}>{description}</p>

      {(status.state === 'installed-unhealthy' || status.state === 'installed-stopped') && status.health?.manuallyStopped && (
        <p style={{ opacity: 0.7, margin: '8px 0 0' }}>{st('manuallyStopped')}</p>
      )}
      {status.health?.setup && (
        <p style={{ opacity: 0.85, margin: '8px 0 0' }}>{st('setupWait')}</p>
      )}
      {status.health?.errors && Object.keys(status.health.errors).length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 600 }}>{st('engineError')}</div>
          {Object.entries(status.health.errors).map(([name, detail]) => (
            <div key={name} style={{ ...monoStyle, color: 'var(--dsh-danger, #d64545)', marginTop: 4 }}>
              {name}: {detail}
            </div>
          ))}
        </div>
      )}

      {(status.state === 'not-installed' || status.state === 'prereq-missing' || installing) && (
        <PrereqList prereqs={status.prereqs} title={st('prereqsTitle')} />
      )}

      {(installing || status.setup.current || STAGES.some((id) => status.setup.stages[id]?.status !== 'pending')) && (
        <StageList setup={status.setup} st={st} />
      )}

      <div style={{ marginTop: 20, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {(status.state === 'not-installed' || installing || (failed && !coreMissing)) && (
          <Button
            primary
            disabled={installing || coreMissing}
            label={installing ? st('installing') : failed ? st('installResume') : st('install')}
            onClick={() => { void install() }}
          />
        )}
        {status.state === 'installed-stopped' && !installing && (
          <Button primary disabled={busy !== null} label={busy === 'start' ? st('starting') : st('start')} onClick={() => { void act('start', '/superagent-console/api/engine/start') }} />
        )}
        {status.state === 'installed-unhealthy' && !installing && (
          <Button primary disabled={busy !== null} label={busy === 'restart' ? st('restarting') : st('restart')} onClick={() => { void act('restart', '/superagent-console/api/engine/restart') }} />
        )}
        <Button disabled={busy !== null} label={st('retry')} onClick={() => { void refresh() }} />
      </div>

      {error && <div style={{ color: 'var(--dsh-danger, #d64545)', marginTop: 12 }}>{error}</div>}

      <div style={{ ...monoStyle, opacity: 0.6, marginTop: 16 }}>{st('target')}: {status.target}</div>
      </div>
    </div>
  )
}
