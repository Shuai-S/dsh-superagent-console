/**
 * Browser client entry for dsh-superagent-console.
 *
 * Registers the same sidebar/menu surfaces as the official panel but mounts
 * our Gate: the official panel while the engine runs, the setup card
 * (detection, online install, start/restart) otherwise. The official
 * dictionaries are registered verbatim so the vendored panel renders in its
 * own locale namespace; setup strings live in a separate one.
 *
 * Built to lib/client.js by tsdown with the ModuleLoader banner (see
 * tsdown.config.ts) — the banner id here must stay dsh-superagent-console.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { Gate, type ClientContext } from './client/gate.tsx'
import { setupEn, setupZh, type SetupT } from './client/setup-locale.ts'
import { en, zh } from './vendor/client/locales.ts'

const NS = 'dshSuperagent'
const SETUP_NS = 'dshSuperagentConsole'
const PANEL_ID = 'dsh-superagent-console' as MainPanelId

function HammerIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3.5h9l3.5 1.75v2.5L15 9.5H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" /><path d="M10 9.5v10.25a1.75 1.75 0 0 0 3.5 0V9.5" /><path d="M10 15.5h3.5" />
  </svg>
}

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent-console: official dictionaries')
  ctx.effect(() => ctx.locale.register(SETUP_NS, { zh: setupZh, en: setupEn }), 'dsh-superagent-console: setup dictionaries')
  const t = ctx.locale.bind(NS)
  const st = ctx.locale.bind(SETUP_NS)
  ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL_ID, locale: SETUP_NS, inject: () => ({}) },
    (props: { t: SetupT }) => <Gate ctx={ctx} t={t} st={props.t} />,
  ))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => st('panel'), locale: SETUP_NS },
    HammerIcon,
  ))
}

// Re-exported for type consumers only; runtime wiring happens in apply.
export type { ClientContext, SetupT }
