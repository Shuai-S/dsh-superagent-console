/**
 * Plugins tab for the official panel. The install dialog is rebuilt on the
 * desktop client's own ui-primitives (required at runtime — kept external by
 * tsdown, resolved by the ModuleLoader registry exactly like the native
 * manager does), so the modal shares the native plugin dialog's typography,
 * colors, focus rings and animation. Page-level dialog rules are ported
 * verbatim from the native manager's CSS module under sgc-* class names
 * (widths, gaps, the safety footer, the anchored registry popover).
 *
 * Backend contract (src/plugins.ts): install/remove run
 * dsh plugin --profile <name> add|remove server-side (single-flight,
 * argv-only, redacted, audited); enable/disable edits the engine profile's
 * dsh.profile.bundles. Engine-core rows are protected server-side and
 * rendered read-only here. Every mutation applies at the next engine start.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as ui from '@deepseek-ai/dsh-client-ui-primitives'
import { usePoll } from '../vendor/client/api.ts'
import { Button, Dot, Icon, InfoTip, StateDot, Switch, Tag } from '../vendor/client/controls.tsx'
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

export interface InstalledPluginInfo {
  name: string
  spec: string
  version: string | null
  bundle: boolean
}

export interface PluginOperation {
  running: boolean
  kind: 'install' | 'remove' | null
  target: string | null
  exitCode: number | null
  timedOut: boolean
  output: string
  error: string | null
  installed?: InstalledPluginInfo[]
  profileDir?: string
}

/** Offline pre-flight problems (mirrors the native checking phase). */
type InstallProblem = { kind: 'invalid' | 'installed' | 'links'; detail?: string }

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

type InstallStep =
  | { kind: 'editing' }
  | { kind: 'checking' }
  | { kind: 'refused'; problems: InstallProblem[] }
  | { kind: 'running' }
  | { kind: 'done' }
  | { kind: 'failed' }

const GUIDE_ITEMS = [
  { key: 'Npm', example: 'dsh-plugin-whale-pet', titleKey: 'plugins.installGuideNpm', hintKey: 'plugins.installGuideNpmHint' },
  { key: 'Git', example: 'github:owner/dsh-plugin-example', titleKey: 'plugins.installGuideGit', hintKey: 'plugins.installGuideGitHint' },
  { key: 'Path', example: '/Users/me/MyCode/dsh-plugin-example', titleKey: 'plugins.installGuidePath', hintKey: 'plugins.installGuidePathHint' },
] as const

/**
 * Dialog rules ported from the native manager's PluginManagerPage CSS module
 * (values verbatim; class names renamed to the sgc- prefix so they cannot
 * collide with either the native or the engine-panel classes).
 */
const SGC_CSS = `
.sgc-installDialog{width:min(560px,100%);max-height:min(800px,100%)}
.sgc-installContent{min-height:0;overflow-y:auto}
.sgc-installBody{flex-direction:column;gap:12px;min-width:0;display:flex}
.sgc-installField{flex-direction:column;gap:6px;font-size:13px;display:flex}
.sgc-installField input[type=text]{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);height:40px;font:inherit;color:var(--dsw-alias-label-primary);outline:none;padding:0 14px;font-size:13px}
.sgc-installField input[type=text]:focus,.sgc-registryCustomField:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-state-business-primary)}
.sgc-optionsRow{flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px 12px;display:flex}
.sgc-guideToggle{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;align-self:flex-start;align-items:center;gap:4px;margin-top:4px;padding:0;font-size:12.5px;display:inline-flex}
.sgc-guideToggle:hover{color:var(--dsw-alias-label-primary)}
.sgc-guideChevron{transition:transform .16s}
.sgc-guideToggle[aria-expanded=true] .sgc-guideChevron,.sgc-registryToggle[aria-expanded=true] .sgc-guideChevron{transform:rotate(180deg)}
.sgc-guide{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);flex-direction:column;gap:10px;padding:8px 14px;display:flex}
.sgc-guideList{flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;display:flex}
.sgc-guideItem{align-items:flex-start;gap:10px;padding:8px 0;display:flex}
.sgc-guideItem>button{align-self:center}
.sgc-guideMain{flex-direction:column;flex:1;gap:0;min-width:0;display:flex}
.sgc-guideTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}
.sgc-guideHint{color:var(--dsw-alias-label-tertiary);margin:6px 0 0;font-size:12px;line-height:18px}
.sgc-guideExample{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;font-size:12px;line-height:20px}
.sgc-guideExample code{font-family:var(--ds-font-family-code)}
.sgc-guideExampleLabel{color:var(--dsw-alias-label-tertiary)}
.sgc-registryToggle{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);height:28px;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;align-items:center;gap:6px;padding:0 8px 0 10px;font-size:12.5px;display:inline-flex}
.sgc-registryToggle:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.sgc-registryToggle:disabled{cursor:default;opacity:.6}
.sgc-registryToggle[aria-expanded=true]{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3)}
.sgc-registryChosen{color:var(--dsw-alias-label-primary);font-weight:500}
.sgc-registry{z-index:1100;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-lg);width:min(440px,calc(100vw - 24px));box-shadow:var(--dsw-elevation-prominent);border:1px solid var(--dsw-alias-border-l1);flex-direction:column;gap:4px;min-width:0;margin:0;padding:8px;display:flex;position:fixed}
.sgc-registryOption{border-radius:var(--dsw-radius-md);cursor:pointer;border:0;flex-direction:column;gap:4px;padding:8px 10px;display:flex}
.sgc-registryOption:hover{background:var(--dsw-alias-interactive-bg-hover)}
label.sgc-registryOption{flex-direction:row;align-items:flex-start;gap:10px}
.sgc-registryOption input[type=radio]{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);flex:none;margin:2px 0 0}
.sgc-registryTitle{color:var(--dsw-alias-label-primary);flex-wrap:wrap;align-items:center;gap:8px;font-size:13px;line-height:20px;display:flex}
.sgc-registryHint{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;font-size:12px;line-height:18px}
.sgc-registryCustomField{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);height:32px;font:inherit;color:var(--dsw-alias-label-primary);outline:none;margin-left:26px;padding:0 10px;font-size:13px}
.sgc-registryCustomError{margin:0 0 0 26px}
.sgc-installFooter{flex-direction:column;flex:1;gap:20px;min-width:0;display:flex}
.sgc-installSafety{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-secondary);align-items:flex-start;gap:8px;margin:0;padding:10px 12px;font-size:12px;line-height:18px;display:flex}
.sgc-installSafety>svg{color:var(--dsw-alias-state-warn-primary);flex:none;margin-top:2px}
.sgc-installSafetyText{flex-direction:column;gap:4px;min-width:0;display:flex}
.sgc-wide{border-radius:var(--dsw-radius-md);justify-content:center;width:100%;height:40px}
.sgc-inputError{color:var(--dsw-alias-state-error-primary);margin:-4px 0 0;font-size:12px;line-height:18px}
.sgc-dialogActions{display:flex;justify-content:flex-end;gap:10px}
`

function OutputBlock({ output }: { output: string }): React.JSX.Element | null {
  if (!output) return null
  return <pre className="dt-pre" style={{ whiteSpace: 'pre-wrap', margin: '6px 0 0' }}>{output}</pre>
}

const REGISTRY_CHOICES = [
  { value: '', titleKey: 'plugins.registryDefault' },
  { value: 'official', titleKey: 'plugins.registryOfficial' },
  { value: 'npmmirror', titleKey: 'plugins.registryNpmmirror' },
  { value: 'custom', titleKey: 'plugins.registryCustom' },
] as const

function InstallModal({ open, onClose, onSettled }: {
  open: boolean
  onClose: () => void
  onSettled: (ok: boolean) => void
}): React.JSX.Element {
  const { t, notify } = usePanel()
  const [spec, setSpec] = useState('')
  const [step, setStep] = useState<InstallStep>({ kind: 'editing' })
  const [guideOpen, setGuideOpen] = useState(false)
  const [registryOpen, setRegistryOpen] = useState(false)
  const [registry, setRegistry] = useState('')
  const [customRegistry, setCustomRegistry] = useState('')
  const [customInvalid, setCustomInvalid] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [lastOp, setLastOp] = useState<PluginOperation | null>(null)
  const registryToggleRef = useRef<HTMLButtonElement>(null)
  const [registryPos, setRegistryPos] = useState<{ left: number; top: number } | null>(null)
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
    const timer = setInterval(() => { void tick() }, 800)
    void tick()
    return () => { active = false; clearInterval(timer) }
  }, [step.kind])

  // The registry popover anchors under its toggle (portal + fixed positioning,
  // like the native dialog) and closes on outside press or Escape.
  useEffect(() => {
    if (!registryOpen) return
    const place = () => {
      const el = registryToggleRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const width = Math.min(440, window.innerWidth - 24)
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
      const top = Math.min(rect.bottom + 6, window.innerHeight - 200)
      setRegistryPos({ left, top })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [registryOpen])
  useEffect(() => {
    if (!registryOpen) return
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node
      if (registryToggleRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('[data-sgc-registry]')) return
      setRegistryOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setRegistryOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [registryOpen])

  const run = async () => {
    // Registry mirrors the native dialog: default defers to pnpm's own
    // configuration; the two well-known sources and a custom http(s) URL ride
    // through dsh plugin as a pnpm --registry flag.
    let chosen: string | null = null
    if (registry === 'official') chosen = 'https://registry.npmjs.org/'
    else if (registry === 'npmmirror') chosen = 'https://registry.npmmirror.com/'
    else if (registry === 'custom') {
      const url = customRegistry.trim()
      if (!/^https?:\/\/\S+$/.test(url)) {
        setCustomInvalid(true)
        return
      }
      chosen = url
    }
    setRegistryOpen(false)
    setDetailsOpen(false)
    setLastOp(null)
    // Native checking phase first: refuse up front on malformed specs, an
    // already-installed package, or dangling profile links.
    setStep({ kind: 'checking' })
    try {
      const { problems } = await post('/superagent-console/api/plugins/check', { spec: spec.trim() }) as { problems: InstallProblem[] }
      if (problems.length > 0) {
        setStep({ kind: 'refused', problems })
        return
      }
    } catch {
      // A check hiccup must not block the install — the CLI re-validates anyway.
    }
    setStep({ kind: 'running' })
    try {
      await post('/superagent-console/api/plugins/install', { spec: spec.trim(), registry: chosen })
    } catch (failure) {
      notify(errorText(failure))
      setStep({ kind: 'editing' })
    }
  }

  /** 立即启用: mount every bundle the add introduced, then surface the restart notice. */
  const enableNow = async () => {
    const bundles = lastOp?.installed?.filter(item => item.bundle) ?? []
    for (const item of bundles) {
      try {
        await post('/superagent-console/api/plugins/enable', { name: item.name, enabled: true })
      } catch (failure) {
        notify(errorText(failure))
        return
      }
    }
    settled.current(true)
    onClose()
  }

  const editing = step.kind === 'editing'
  const enableTargets = step.kind === 'done' && (lastOp?.installed?.some(item => item.bundle) ?? false)
  const chosenTitle = t((REGISTRY_CHOICES.find((choice) => choice.value === registry) ?? REGISTRY_CHOICES[0]).titleKey)

  return <>
    <style>{SGC_CSS}</style>
    <ui.Modal
      open={open}
      onClose={onClose}
      className="sgc-installDialog"
      contentClassName="sgc-installContent"
      title={step.kind === 'running' ? t('plugins.installingTitle')
        : step.kind === 'failed' ? t('plugins.installFailedTitle') : t('plugins.installTitle')}
      closeLabel={t('plugins.installClose')}
      description={editing ? t('plugins.installDescription') : undefined}
      footer={editing ? <div className="sgc-installFooter">
        <p className="sgc-installSafety" role="note">
          <ui.IconWarningOutlineRegular size={14} aria-hidden="true" />
          <span className="sgc-installSafetyText">
            <span>{t('plugins.installGuideSafety')}</span>
            <span>{t('plugins.installUpgradeNotice')}</span>
          </span>
        </p>
        <ui.Button variant="primary" className="sgc-wide" disabled={!spec.trim()} onClick={() => { void run() }}>
          {t('plugins.installRun')}
        </ui.Button>
      </div> : <div className="sgc-dialogActions">
        {(step.kind === 'running' || step.kind === 'failed') && <ui.Button variant="ghost" onClick={onClose}>{t('plugins.installClose')}</ui.Button>}
        {step.kind === 'refused' && <ui.Button variant="primary" onClick={() => setStep({ kind: 'editing' })}>{t('plugins.installEdit')}</ui.Button>}
        {step.kind === 'failed' && <ui.Button variant="ghost" onClick={() => setStep({ kind: 'editing' })}>{t('plugins.installChangeRegistry')}</ui.Button>}
        {step.kind === 'failed' && <ui.Button variant="primary" onClick={() => { void run() }}>{t('plugins.installRetry')}</ui.Button>}
        {step.kind === 'done' && <ui.Button variant="ghost" onClick={onClose}>{t('plugins.installClose')}</ui.Button>}
        {step.kind === 'done' && enableTargets && <ui.Button variant="primary" onClick={() => { void enableNow() }}>{t('plugins.installEnableNow')}</ui.Button>}
      </div>}
    >
      {editing && <div className="sgc-installBody">
        <div className="sgc-installField">
          <input
            type="text"
            autoFocus
            data-modal-autofocus
            value={spec}
            placeholder={t('plugins.installSpecPlaceholder')}
            aria-label={t('plugins.installSpecLabel')}
            onChange={event => { setSpec(event.target.value) }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter' && spec.trim()) { event.preventDefault(); void run() }
            }}
          />
        </div>
        <div className="sgc-optionsRow">
          <button type="button" className="sgc-guideToggle" aria-expanded={guideOpen}
            onClick={() => setGuideOpen(!guideOpen)}>
            <ui.IconChevronDownOutlineRegular className="sgc-guideChevron" size={13} aria-hidden="true" />
            <span>{guideOpen ? t('plugins.installGuideHide') : t('plugins.installGuideToggle')}</span>
          </button>
          <button ref={registryToggleRef} type="button" className="sgc-registryToggle"
            aria-expanded={registryOpen} aria-haspopup="dialog"
            onClick={() => setRegistryOpen(!registryOpen)}>
            <span>{t('plugins.registryTitle')}</span>
            {' '}
            <span className="sgc-registryChosen">{chosenTitle}</span>
            <ui.IconChevronDownOutlineRegular className="sgc-guideChevron" size={12} aria-hidden="true" />
          </button>
        </div>
        {guideOpen && <div className="sgc-guide">
          <ol className="sgc-guideList">
            {GUIDE_ITEMS.map(({ key, example, titleKey, hintKey }) => <li key={key} className="sgc-guideItem">
              <div className="sgc-guideMain">
                <span className="sgc-guideTitle">{t(titleKey)}</span>
                <span className="sgc-guideHint">{t(hintKey)}</span>
                <span className="sgc-guideExample">
                  <span className="sgc-guideExampleLabel">{t('plugins.installGuideExampleLabel')}</span>
                  <code>{example}</code>
                </span>
              </div>
              <ui.Button variant="outline" size="sm" aria-label={t('plugins.fillExample', { example })}
                onClick={() => setSpec(example)}>{t('plugins.installGuideFill')}</ui.Button>
            </li>)}
          </ol>
        </div>}
        {registryOpen && createPortal(
          <fieldset className="sgc-registry" data-sgc-registry aria-label={t('plugins.registryLegend')}
            style={registryPos ?? { visibility: 'hidden', left: 0, top: 0 }}>
            {REGISTRY_CHOICES.map(({ value, titleKey }) => <label key={value || 'default'} className="sgc-registryOption">
              <input type="radio" name="sgc-registry-choice" checked={registry === value}
                onChange={() => { setRegistry(value); if (value !== 'custom') setCustomInvalid(false) }} />
              <span className="sgc-registryTitle">{t(titleKey)}</span>
            </label>)}
            {registry === 'custom' && <>
              <input type="text" className="sgc-registryCustomField" value={customRegistry}
                placeholder={t('plugins.registryCustomPlaceholder')} aria-invalid={customInvalid || undefined}
                aria-label={t('plugins.registryCustom')}
                onChange={event => { setCustomRegistry(event.target.value); setCustomInvalid(false) }} />
              <p className={customInvalid ? 'sgc-inputError sgc-registryCustomError' : 'sgc-registryHint sgc-registryCustomError'}>
                {customInvalid ? t('plugins.registryCustomInvalid') : t('plugins.registryCustomHint')}
              </p>
            </>}
          </fieldset>, document.body)}
      </div>}
      {step.kind === 'checking' && <div className="dt-row">
        <Dot state="ongoing" />
        <div className="dt-row-main"><div className="dt-row-title">{t('plugins.installChecking')}</div></div>
      </div>}
      {step.kind === 'refused' && <div>
        <div className="dt-row">
          <Dot state="error" />
          <div className="dt-row-main">
            <div className="dt-row-title">{t('plugins.installConfirmedRefused')}</div>
            <div className="dt-row-meta">
              {step.problems.map((problem, index) => <div key={index}>
                {problem.kind === 'invalid' && t('plugins.installProblemInvalid', { reason: problem.detail ?? '' })}
                {problem.kind === 'installed' && t('plugins.installProblemInstalled')}
                {problem.kind === 'links' && t('plugins.problemLinks')}
              </div>)}
            </div>
          </div>
        </div>
      </div>}
      {step.kind === 'running' && <div>
        <div className="dt-row">
          <Dot state="ongoing" />
          <div className="dt-row-main">
            <div className="dt-row-title">{(lastOp?.output ?? '') === '' ? t('plugins.installStarting') : t('plugins.installingTitle')}</div>
            <div className="dt-row-meta">{t('plugins.installBackground')}</div>
          </div>
        </div>
        {lastOp?.output && <OutputBlock output={lastOp.output} />}
      </div>}
      {step.kind === 'done' && <div>
        <div className="dt-row">
          <Dot state="done" />
          <div className="dt-row-main">
            <div className="dt-row-title">{t('plugins.installedTitle')}</div>
            {(lastOp?.installed?.length ?? 0) > 0 && <div className="dt-row-meta">
              {lastOp!.installed!.map(item => <div key={item.name}>
                {item.name}{item.version ? ' · ' + t('plugins.installVersion', { version: item.version }) : ''}
              </div>)}
            </div>}
          </div>
        </div>
        {lastOp?.profileDir && <p className="dt-row-meta">{t('plugins.installLocation', { dir: lastOp.profileDir })}</p>}
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
    </ui.Modal>
  </>
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
