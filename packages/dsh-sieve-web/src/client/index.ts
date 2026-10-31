/**
 * dsh-sieve-web, browser half: two right-Sidebar tabs, one showing the open
 * session's context reduction and the Jev keys the judge uses, one showing its
 * hives, through the Host half's routes on Connection's `/api` channel.
 * Exports only what Cordis loading needs.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { API_CHANNEL } from '../protocol.ts'
import { en, NS, zh } from './locales.ts'
import { SievePanel } from './Panel.tsx'
import type { SievePanelInjected } from './Panel.tsx'
import { PanelSource } from './source.ts'
import { SieveHivePanel } from './HivePanel.tsx'
import type { SieveHivePanelInjected } from './HivePanel.tsx'
import { HiveSource } from './hive-source.ts'
import { mountStyles } from './styles.ts'

export const inject = ['slots', 'locale', 'sidebarRightTabs', 'connection']

/** Tab type identity: the package name, as the Sidebar recommends. */
const PANEL_ID = 'dsh-sieve-web'
/** What `openTab` names; one page per pane. */
const PANEL_KIND = 'sieve'
/** Position among guide entries; after the shipped ones. */
const GUIDE_ORDER = 80
/** The Hive page: a tab of its own, so it can sit beside the session. */
const HIVE_ID = 'dsh-sieve-web-hive'
const HIVE_KIND = 'sieve-hive'

/** The browser Connection face. Read by name: no shipped declaration types it on `Context` for a plugin. */
function connectionOf(ctx: Context): { readonly rpc: ClientConnectionRpc } {
  return Reflect.get(ctx, 'connection') as { readonly rpc: ClientConnectionRpc }
}

/**
 * Register the panel for this plugin's lifetime.
 * @param ctx - browser context with slots, locale, the Sidebar tab registry and Connection.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'sieve-web: dictionaries')
  ctx.effect(() => mountStyles(document), 'sieve-web: styles')

  const rpc = connectionOf(ctx).rpc
  const faces = new Map<string, { readonly source: PanelSource; readonly face: SievePanelInjected }>()
  ctx.effect(() => () => {
    for (const { source } of faces.values()) source.dispose()
    faces.clear()
  }, 'sieve-web: status sources')
  // One source and one injected face per session, so the body's callbacks keep their identity across renders.
  const faceOf = (sessionId: string): SievePanelInjected => {
    const existing = faces.get(sessionId)
    if (existing !== undefined) return existing.face
    const source = new PanelSource(sessionId, (endpoint, payload, signal) => rpc.call(API_CHANNEL, endpoint, payload, signal))
    const face: SievePanelInjected = {
      hooks: { panel: source },
      refresh: () => source.refresh(),
      setKey: (service, apiKey) => source.setKey(service, apiKey),
    }
    faces.set(sessionId, { source, face })
    return face
  }
  const hives = new Map<string, { readonly source: HiveSource; readonly face: SieveHivePanelInjected }>()
  ctx.effect(() => () => {
    for (const { source } of hives.values()) source.dispose()
    hives.clear()
  }, 'sieve-web: hive sources')
  const hiveFaceOf = (sessionId: string): SieveHivePanelInjected => {
    const existing = hives.get(sessionId)
    if (existing !== undefined) return existing.face
    const source = new HiveSource(sessionId, (endpoint, payload, signal) => rpc.call(API_CHANNEL, endpoint, payload, signal))
    const face: SieveHivePanelInjected = { hooks: { hive: source }, refresh: () => source.refresh() }
    hives.set(sessionId, { source, face })
    return face
  }
  // A new connection generation may follow a Host restart; re-read what is on screen.
  ctx.on('connection/reset', () => {
    for (const { source } of faces.values()) if (source.started) void source.refresh()
    for (const { source } of hives.values()) if (source.started) void source.refresh()
  })

  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: PANEL_ID,
    kind: PANEL_KIND,
    title: () => t('tab.title'),
    guide: [{ id: 'open', order: GUIDE_ORDER, title: () => t('tab.title'), description: () => t('tab.description') }],
  }), 'sieve-web: sidebar tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: PANEL_ID,
    locale: NS,
    inject: (sessionId): SievePanelInjected => faceOf(String(sessionId)),
  }, SievePanel))

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: HIVE_ID,
    kind: HIVE_KIND,
    title: () => t('hive.tab.title'),
    guide: [{ id: 'open', order: GUIDE_ORDER + 1, title: () => t('hive.tab.title'), description: () => t('hive.tab.description') }],
  }), 'sieve-web: hive tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: HIVE_ID,
    locale: NS,
    inject: (sessionId): SieveHivePanelInjected => hiveFaceOf(String(sessionId)),
  }, SieveHivePanel))
}
