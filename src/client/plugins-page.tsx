/** 
 * Plugins tab for the official panel, styled after the DSH native plugin
 * manager: a header with refresh and add-plugin actions, an install dialog
 * with guide and examples, classified install failures, an uninstall
 * confirmation, and a restart notice. Backed by the console API
 * (/superagent-console/api/plugins*) and rendered with the panel's own
 * primitives (dt-* classes mirror DSH ui-primitives).
 *
 * Backend contract (src/plugins.ts): install/remove run
 * dsh plugin --profile <name> add|remove server-side (single-flight,
 * argv-only, redacted, audited); enable/disable edits the engine profile's
 * dsh.profile.bundles. Engine-core rows are protected server-side and
 * rendered read-only here. Every mutation applies at the next engine start.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { usePoll } from '../vendor/client/api.ts'
import { Button, Dot, Icon, InfoTip, Input, Modal, StateDot, Switch, Tag } from '../vendor/client/controls.tsx'
import { useAction, usePanel } from '../vendor/client/provider.tsx'
import { ConfirmButton, Section } from '../vendor/client/widgets.tsx'
import { errorText } from '../vendor/client/text.ts'

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
    const message = (payload as { error?: string }).error ?? 'HTTP ' + String(response.status)
    throw new Error(message)
  }
  return payload as T
}

const post = (path: string, body: unknown): Promise<unknown> => consoleApi(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

// -- install failure classification (mirrors the native manager's kinds) ----

const FAILURE_KINDS = ['network', 'notFound', 'version', 'disk', 'permission', 'build', 'integrity', 'timeout', 'generic'] as const
type FailureKind = typeof FAILURE_KINDS[number]
const failureKey = (kind: FailureKind) => ('plugins.failure.' + kind) as `plugins.failure.${FailureKind}`

function classifyFailure(op: PluginOperation): FailureKind {
  if (op.timedOut) return 'timeout'
  const log = op.output
  if (/ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/.test(log)) return 'build'
  if (/ERR_PNPM_FETCH_404|\bE404\b|404 Not Found/.test(log)) return 'notFound'
  if (/ERR_PNPM_NO_MATCHING_VERSION|\bETARGET\b|No matching version/.test(log)) return 'version'
  if (/\bENOSPC\b|no space left/i.test(log)) return 'disk'
  if (/\bEACCES\b|\bEPERM\b|permission denied/i.test(log)) return 'permission'
  if (/ERR_PNPM_TARBALL_INTEGRITY|\bEINTEGRITY\b/.test(log)) return 'integrity'
  if (/\bENOTFOUND\b|\bECONNRESET\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bEAI_AGAIN\b|FETCH_ERROR|Could not resolve/i.test(log)) return 'network'
  return 'generic'
}

// -- install dialog: editing -> running -> done/failed, like the native flow

type InstallStep = { kind: 'editing' } | { kind: 'running' } | { kind: 'done' } | { kind: 'failed' }

const GUIDE_EXAMPLES = [
  { key: 'Npm', example: 'dsh-plugin-whale-pet' },
  { key: 'Git', example: 'github:owner/dsh-plugin-example' },
  { key: 'Path', example: '/Users/me/MyCode/dsh-plugin-example' },
] as const

function GuideText({ kind }: { kind: 'Npm' | 'Git' | 'Path' }): React.JSX.Element {
  const { t } = usePanel()
  if (kind === 'Npm') return <>{t('plugins.installGuideNpm')}</>
  if (kind === 'Git') return <>{t('plugins.installGuideGit')}</>
  return <>{t('plugins.installGuidePath')}</>
}

function OutputBlock({ output }: { output: string }): React.JSX.Element | null {
  if (!output) return null
  return <pre className="dt-pre" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{output}</pre>
}

function InstallModal({ open, onClose, onSettled }: {
  open: boolean
  onClose: () => void
  onSettled: (ok: boolean) => void
}): React.JSX.Element {
  const { t, notify } = usePanel()
  const [spec, setSpec] = useState('')
  const [step, setStep] = useState<InstallStep>({ kind: 'editing' })
  const [guideOpen, setGuideOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [lastOp, setLastOp] = useState<PluginOperation | null>(null)
  const [registry, setRegistry] = useState('')
  const [customRegistry, setCustomRegistry] = useState('')
  const settled = useRef(onSettled)
  settled.current = onSettled

  // While the backend install runs, poll the operation endpoint; the modal
  // mirrors its phases and closes the loop on done/failed.
  useEffect(() => {
    if (step.kind !== 'running') return
    let active = true
    const tick = async () => {
      try {
        const op = await consoleApi<PluginOperation>('/superagent-console/api/plugins/operation')
        if (!active || op.running) return
        setLastOp(op)
        const ok = op.exitCode === 0
        setStep(ok ? { kind: 'done' } : { kind: 'failed' })
        settled.current(ok)
      } catch {
        // A transient server hiccup keeps polling; the op outlives the request.
      }
    }
    const timer = setInterval(() => { void tick() }, 1500)
    void tick()
    return () => { active = false; clearInterval(timer) }
  }, [step.kind])

  const run = async () => {
    // Registry mirrors the native dialog: default defers to pnpm's own
    // configuration; the two well-known sources and a custom http(s) URL ride
    // through dsh plugin as a pnpm --registry flag.
    let chosen: string | null = null
    if (registry === 'official') chosen = 'https://registry.npmjs.org/'
    else if (registry === 'npmmirror') chosen = 'https://registry.npmmirror.com/'
    else if (registry === 'custom') {
      chosen = customRegistry.trim()
      if (!/^https?:\/\/\S+$/.test(chosen)) {
        notify(t('plugins.registryCustomInvalid'))
        return
      }
    }
    setDetailsOpen(false)
    setLastOp(null)
    setStep({ kind: 'running' })
    try {
      await post('/superagent-console/api/plugins/install', { spec: spec.trim(), registry: chosen })
    } catch (failure) {
      notify(errorText(failure))
      setStep({ kind: 'editing' })
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (spec.trim() && step.kind === 'editing') void run()
  }

  return <Modal
    open={open}
    onClose={onClose}
    className="dt-plugins-modal"
    title={step.kind === 'running' ? t('plugins.installingTitle')
      : step.kind === 'failed' ? t('plugins.installFailedTitle') : t('plugins.installTitle')}
    closeLabel={t('plugins.installClose')}
    description={step.kind === 'editing' ? t('plugins.installDescription') : undefined}
    footer={step.kind === 'editing' ? undefined : <>
      {step.kind === 'running' && <Button variant="ghost" onClick={onClose}>{t('plugins.installClose')}</Button>}
      {step.kind === 'failed' && <Button variant="ghost" onClick={onClose}>{t('plugins.installClose')}</Button>}
      {step.kind === 'failed' && <Button variant="primary" onClick={() => { void run() }}>{t('plugins.installRetry')}</Button>}
      {step.kind === 'done' && <Button variant="primary" onClick={onClose}>{t('plugins.installClose')}</Button>}
    </>}
  >
    {step.kind === 'editing' && <form onSubmit={submit}>
      <Input type="text" value={spec} placeholder={t('plugins.installSpecPlaceholder')} aria-label={t('plugins.installSpecLabel')}
        style={{ width: '100%' }} onChange={event => { setSpec(event.target.value) }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12 }}>
        <button type="button" className="dt-textlink" aria-expanded={guideOpen}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={() => setGuideOpen(!guideOpen)}>
          <Icon name={guideOpen ? 'chevron-up' : 'chevron-down'} size={14} />
          {guideOpen ? t('plugins.installGuideHide') : t('plugins.installGuideToggle')}
        </button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 8, padding: '0 10px', height: 34 }}>
          <span style={{ fontSize: 13, opacity: 0.7, whiteSpace: 'nowrap' }}>{t('plugins.registryTitle')}</span>
          <select className="dt-select" style={{ border: 'none', background: 'transparent', width: 'auto', height: 'auto', padding: 0 }}
            aria-label={t('plugins.registryTitle')} value={registry}
            onChange={event => setRegistry(event.target.value)}>
            <option value="">{t('plugins.registryDefault')}</option>
            <option value="official">{t('plugins.registryOfficial')}</option>
            <option value="npmmirror">{t('plugins.registryNpmmirror')}</option>
            <option value="custom">{t('plugins.registryCustom')}</option>
          </select>
        </span>
      </div>
      {registry === 'custom' && <div style={{ marginTop: 10 }}>
        <Input type="text" value={customRegistry} placeholder={t('plugins.registryCustomPlaceholder')}
          aria-label={t('plugins.registryCustom')} style={{ width: '100%' }}
          onChange={event => { setCustomRegistry(event.target.value) }} />
        <p className="dt-hint">{t('plugins.registryCustomHint')}</p>
      </div>}
      {guideOpen && <div className="dt-disclosure-body" style={{ marginTop: 12 }}>
        {GUIDE_EXAMPLES.map(({ key, example }) => <div key={key} className="dt-row">
          <Dot state="idle" />
          <div className="dt-row-main">
            <div className="dt-row-title dt-line-text"><GuideText kind={key} /></div>
            <div className="dt-row-meta">
              <code className="dt-code">{example}</code>
              <button type="button" className="dt-textlink" aria-label={t('plugins.fillExample', { example })}
                onClick={() => setSpec(example)}>{t('plugins.fill')}</button>
            </div>
          </div>
        </div>)}
      </div>}
      <div className="dt-banner" style={{ marginTop: 12 }}>
        <span style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 6 }}>
          <Icon name="alert" size={14} />
          <span>{t('plugins.installGuideSafety')}</span>
        </span>
      </div>
      <Button variant="primary" style={{ width: '100%', marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        disabled={!spec.trim()} onClick={() => { void run() }}>{t('plugins.installRun')}</Button>
    </form>}
    {step.kind === 'running' && <div>
      <div className="dt-row">
        <Dot state="ongoing" />
        <div className="dt-row-main">
          <div className="dt-row-title">{t('plugins.installingTitle')}</div>
          <div className="dt-row-meta">{t('plugins.installBackground')}</div>
        </div>
      </div>
      {lastOp?.output && <OutputBlock output={lastOp.output} />}
    </div>}
    {step.kind === 'done' && <div className="dt-row">
      <Dot state="done" />
      <div className="dt-row-main"><div className="dt-row-title">{t('plugins.installDoneRestart')}</div></div>
    </div>}
    {step.kind === 'failed' && lastOp && <div>
      <div className="dt-row">
        <Dot state="error" />
        <div className="dt-row-main">
          <div className="dt-row-title">{t(failureKey(classifyFailure(lastOp)))}</div>
          <div className="dt-row-meta">
            <button type="button" className="dt-textlink" aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen(!detailsOpen)}>
              {detailsOpen ? t('plugins.installDetailsHide') : t('plugins.installDetailsShow')}
            </button>
          </div>
          {detailsOpen && <OutputBlock output={lastOp.output} />}
        </div>
      </div>
    </div>}
  </Modal>
}
// -- page --------------------------------------------------------------------

function PluginItem({ row, busy, onUninstall, onToggle }: {
  row: PluginRow
  busy: boolean
  onUninstall: (name: string) => Promise<unknown>
  onToggle: (name: string, enabled: boolean) => Promise<unknown>
}): React.JSX.Element {
  const { t } = usePanel()
  return <li className="dt-row">
    <Dot state={row.protectedCore ? 'done' : row.bundle ? (row.enabled ? 'done' : 'warning') : 'idle'} />
    <div className="dt-row-main">
      <div className="dt-row-title">
        <span className="dt-row-name">{row.name}</span>
        {row.version && <Tag tone="quiet" title={row.version}>{'v' + row.version}</Tag>}
        {row.protectedCore && <Tag tone="info" title={t('plugins.protectedReason')}>{t('plugins.protected')}</Tag>}
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
          label={t('plugins.enableToggle', { name: row.name })} />
      </span>}
      {!row.protectedCore && <ConfirmButton label={t('plugins.uninstall')} title={t('plugins.uninstallTitle', { name: row.name })}
        message={t('plugins.uninstallDescription')} icon="trash" variant="ghost"
        onConfirm={() => onUninstall(row.name)} />}
    </div>
  </li>
}

/** The plugins roster page, mounted by the vendored panel's route switch. */
export function PluginsPage(): React.JSX.Element {
  const { t } = usePanel()
  const [installOpen, setInstallOpen] = useState(false)
  const [needsRestart, setNeedsRestart] = useState(false)
  // Fixed 3s cadence: quick enough to track an operation, cheap to poll always.
  const { data, error, reload } = usePoll<PluginsPayload>(
    () => consoleApi<PluginsPayload>('/superagent-console/api/plugins'), [], 3000)
  const rows = data?.rows ?? []
  const op = data?.operation
  const opRunning = op?.running === true
  // 刷新 = 立即拉取一次；转圈反馈让它与 3s 自动轮询可感知地区分开。
  const [refreshing, setRefreshing] = useState(false)
  const refreshNow = useCallback(async () => {
    setRefreshing(true)
    try { await reload() } finally { setRefreshing(false) }
  }, [reload])
  const mutate = useAction(async (path: string, body: unknown) => { await post(path, body) }, { reload })
  const restart = useAction(async () => { await post('/superagent-console/api/engine/restart', {}) }, { reload })
  const onToggle = useCallback(async (name: string, enabled: boolean) => {
    await mutate.run('/superagent-console/api/plugins/enable', { name, enabled })
    setNeedsRestart(true)
  }, [mutate])
  const onUninstall = useCallback(async (name: string) => {
    await mutate.run('/superagent-console/api/plugins/remove', { name })
    setNeedsRestart(true)
  }, [mutate])

  return <div className="dt-form">
    <style>{'.dt-plugins-modal.dt-modal { width: min(680px, 100%); }'}</style>
    <div className="dt-status-head">
      <h2 className="dt-status-title">{t('tab.plugins')}
        <InfoTip text={t('plugins.hint')} />
      </h2>
      <div className="dt-row-actions">
        <Button variant="outline" size="sm" disabled={refreshing}
          icon={refreshing ? <StateDot state="ongoing" /> : <Icon name="refresh" size={14} />}
          onClick={() => { void refreshNow() }}>
          {t('plugins.refresh')}
        </Button>
        <Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />} onClick={() => setInstallOpen(true)}>
          {t('plugins.addPlugin')}
        </Button>
      </div>
    </div>
    <p className="dt-hint">{t('plugins.intro')}</p>

    {needsRestart && <div className="dt-banner">
      <span className="dt-banner-label">{t('plugins.restartNotice')}</span>
      <div className="dt-banner-actions">
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />}
          disabled={restart.busy} onClick={() => { void restart.run().then(done => { if (done) setNeedsRestart(false) }) }}>
          {restart.busy ? t('plugins.restarting') : t('plugins.restart')}
        </Button>
      </div>
    </div>}
    {opRunning && op && <div className="dt-banner">
      <span className="dt-banner-label">
        {op.kind === 'install' ? t('plugins.opInstallRunning', { target: op.target ?? '' }) : t('plugins.opUninstallRunning', { target: op.target ?? '' })}
      </span>
      <OutputBlock output={op.output} />
    </div>}
    {!opRunning && op && op.kind !== null && op.exitCode !== 0 && <div className="dt-banner dt-danger">
      <span className="dt-banner-label">{t('plugins.opFailed', { error: op.error ?? String(op.exitCode) })}</span>
      <OutputBlock output={op.output} />
    </div>}

    <Section title={t('plugins.installedGroup')} count={rows.length} icon="queue">
      {error && <p className="dt-error" role="alert">{error.message}</p>}
      {data !== undefined && rows.length === 0 && <p className="dt-hint">{t('plugins.empty')}</p>}
      {rows.length > 0 && <ul className="dt-list">
        {rows.map(row => <PluginItem key={row.name} row={row} busy={opRunning}
          onUninstall={onUninstall} onToggle={onToggle} />)}
      </ul>}
      {data?.profileInstalled && <p className="dt-hint"><code className="dt-code">{data.profileDir}</code></p>}
    </Section>

    <InstallModal open={installOpen} onClose={() => setInstallOpen(false)}
      onSettled={ok => { setNeedsRestart(true); void reload() }} />
  </div>
}
