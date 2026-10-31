/**
 * The Hive tab body: a session's hives, one at a time. Each bee with its
 * model, state and latest words; the map of what the judge handed between
 * them; the note flow; the gate verdicts.
 *
 * The map follows mu's (`KyrnPanel/Hive/Graph`): bees on a ring, a line per
 * pair notes went between, thicker the more went that way, an arrow at the
 * receiving end, a bar across a correction, a dashed line for a dispute.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SieveHiveBee, SieveHiveLink, SieveHiveRun } from 'dsh-sieve/status'
import { AVATAR_RADIUS, NODE_WIDTH, bendOf, linkPath, ringLayout } from './graph.ts'
import type { HiveSource, HiveState } from './hive-source.ts'
import type { PanelError } from './source.ts'
import type { PanelTranslate } from './Panel.tsx'
import { POLL_MS } from './Panel.tsx'

/** Stage width before the page has measured itself, e.g. when rendered off-screen. */
export const DEFAULT_STAGE = 320
const SAID_CHARS = 160

export interface SieveHivePanelInjected {
  readonly hooks: { readonly hive: Pick<HiveSource, 'getSnapshot' | 'subscribe'> }
  readonly refresh: () => Promise<void>
}

export type SieveHivePanelProps = Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'useSession' | 'useTabInfo'>
  & InjectFace<SieveHivePanelInjected> & PropsLocale<'sieve'>

/**
 * Bind the session's hives to the page: read when the tab becomes visible or
 * the session starts or stops, poll while it runs, answer the refresh command.
 * @param props - framework hooks, the injected source and refresh, and `t`.
 * @returns the page.
 */
export function SieveHivePanel(props: SieveHivePanelProps): ReactNode {
  const { refresh, t } = props
  const info = props.useTabInfo()
  const visible = info.tab.visible
  const actions = info.tab.actions
  const running = props.useSession((session: { readonly running: boolean }) => session.running)
  const state = props.useHive(snapshot => snapshot)
  useEffect(() => actions.bindCommands({ refresh: () => { void refresh() } }), [actions, refresh])
  useEffect(() => {
    if (visible) void refresh()
  }, [visible, running, refresh])
  useEffect(() => {
    if (!visible || !running) return undefined
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [visible, running, refresh])
  return <HiveView state={state} t={t} onRefresh={() => { void refresh() }} />
}

export interface HiveViewProps {
  readonly state: HiveState
  readonly t: PanelTranslate
  readonly onRefresh: () => void
}

function errorText(t: PanelTranslate, error: PanelError): string {
  switch (error.kind) {
    case 'unavailable': return t('error.unavailable')
    case 'rejected': return t('error.rejected', { message: `${error.code}: ${error.message}` })
    case 'version': return t('error.version')
  }
}

function clip(text: string, length: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`
}

/**
 * The page without framework hooks, so it renders from plain props. Shows
 * the latest run unless another was picked.
 * @param props - hive state, `t`, and the refresh callback.
 * @returns the page markup.
 */
export function HiveView({ state, t, onRefresh }: HiveViewProps): ReactNode {
  const view = state.view
  const [picked, setPicked] = useState<string | undefined>(undefined)
  const runs = view?.runs ?? []
  const run = runs.find(entry => entry.id === picked) ?? runs.at(-1)
  return (
    <div className="sieve-panel sieve-hive" aria-busy={state.loading}>
      <div className="sieve-header">
        <span className="sieve-title">{t('hive.tab.title')}</span>
        <Button size="sm" variant="ghost" aria-label={t('header.refresh')} title={t('header.refresh')} onClick={onRefresh}>
          <IconRefreshOutlineRegular />
        </Button>
      </div>
      {state.error === undefined ? undefined : <div className="sieve-error" role="alert">{errorText(t, state.error)}</div>}
      {view === undefined
        ? (state.error === undefined ? <div className="sieve-notice">{t('state.loading')}</div> : undefined)
        : !view.enabled
          ? <div className="sieve-notice">{t('hive.disabled')}</div>
          : run === undefined
            ? <div className="sieve-notice">{t('hive.empty')}</div>
            : (
              <>
                {runs.length > 1
                  ? (
                    <div className="sieve-hive-runs" role="group" aria-label={t('hive.runs')}>
                      {runs.map((entry, index) => (
                        <Button
                          key={entry.id}
                          size="sm"
                          variant={entry === run ? 'primary' : 'ghost'}
                          aria-pressed={entry === run}
                          title={t(`hive.status.${entry.status}`)}
                          onClick={() => { setPicked(entry.id) }}
                        >
                          {t('hive.runLabel', { index: index + 1 })}
                        </Button>
                      ))}
                    </div>
                    )
                  : undefined}
                <RunView run={run} t={t} />
              </>
              )}
    </div>
  )
}

function RunView({ run, t }: { readonly run: SieveHiveRun, readonly t: PanelTranslate }): ReactNode {
  return (
    <>
      <section className="sieve-section" data-run={run.id} data-status={run.status}>
        <p className="sieve-hive-goal" dir="auto">{run.goal}</p>
        <p className="sieve-detail">
          <span className="sieve-hive-status" data-status={run.status}>{t(`hive.status.${run.status}`)}</span>
          {' · '}
          {t('hive.counts', run.counts)}
        </p>
        {run.notes.map(note => <div key={note} className="sieve-notice">{note}</div>)}
      </section>
      <section className="sieve-section" aria-labelledby={`sieve-hive-bees-${run.id}`}>
        <h3 id={`sieve-hive-bees-${run.id}`}>{t('hive.bees')}</h3>
        <ul className="sieve-hive-bees">
          {run.bees.map(bee => <BeeRow key={bee.name} bee={bee} t={t} />)}
        </ul>
      </section>
      <HiveGraph bees={run.bees} links={run.links} t={t} />
      <section className="sieve-section" aria-labelledby={`sieve-hive-flow-${run.id}`}>
        <h3 id={`sieve-hive-flow-${run.id}`}>{t('hive.deliveries')}</h3>
        {run.deliveries.length === 0
          ? <p className="sieve-detail">{t('hive.noDeliveries')}</p>
          : (
            <ol className="sieve-hive-list" data-list="deliveries">
              {[...run.deliveries].reverse().map((delivery, index) => (
                <li key={`${index}-${delivery.from}-${delivery.to}`}>
                  <span className="sieve-hive-route">{delivery.from} → {delivery.to}</span>
                  <span className="sieve-hive-kind">{delivery.kind.replace('_', ' ')}</span>
                  <span className="sieve-hive-text" dir="auto">{delivery.text}</span>
                </li>
              ))}
            </ol>
            )}
      </section>
      <section className="sieve-section" aria-labelledby={`sieve-hive-verdicts-${run.id}`}>
        <h3 id={`sieve-hive-verdicts-${run.id}`}>{t('hive.verdicts')}</h3>
        {run.verdicts.length === 0
          ? <p className="sieve-detail">{t('hive.noVerdicts')}</p>
          : (
            <ol className="sieve-hive-list" data-list="verdicts">
              {[...run.verdicts].reverse().map((verdict, index) => (
                <li key={`${index}-${verdict.at}`} data-gate={verdict.gate} data-passed={verdict.passed === null ? undefined : String(verdict.passed)}>
                  <span className="sieve-hive-route">
                    {gateLabel(t, verdict.gate)} · {verdict.bee}
                    {verdict.passed === null ? '' : ` · ${verdict.passed ? t('hive.passed') : t('hive.rejected')}`}
                    {verdict.score === null ? '' : ` · ${verdict.score.toFixed(2)}`}
                  </span>
                  {verdict.text === '' ? undefined : <span className="sieve-hive-text" dir="auto">{verdict.text}</span>}
                </li>
              ))}
            </ol>
            )}
      </section>
    </>
  )
}

const GATES = ['publish', 'relate', 'deliver', 'withheld', 'correct', 'dispute', 'verify'] as const

function gateLabel(t: PanelTranslate, gate: string): string {
  const known = GATES.find(candidate => candidate === gate)
  return known === undefined ? gate : t(`hive.gate.${known}`)
}

function BeeRow({ bee, t }: { readonly bee: SieveHiveBee, readonly t: PanelTranslate }): ReactNode {
  return (
    <li className="sieve-hive-bee" data-bee={bee.name} data-status={bee.status}>
      <div className="sieve-key-head">
        <span className="sieve-key-name" dir="auto">{bee.name}</span>
        {bee.verifier ? <span className="sieve-hive-tag">{t('hive.verifier')}</span> : undefined}
        <span className="sieve-hive-status" data-status={bee.status}>{t(`hive.bee.${bee.status}`)}</span>
      </div>
      <p className="sieve-detail">{bee.placement}</p>
      {bee.said === '' ? undefined : <p className="sieve-hive-text" dir="auto" title={bee.said}>{clip(bee.said, SAID_CHARS)}</p>}
    </li>
  )
}

/** The stage's width, measured once it is on screen. */
function useStageWidth(): { readonly ref: (node: HTMLDivElement | null) => void, readonly width: number } {
  const [width, setWidth] = useState(DEFAULT_STAGE)
  const observer = useRef<ResizeObserver | undefined>(undefined)
  useEffect(() => () => { observer.current?.disconnect() }, [])
  const ref = useCallback((node: HTMLDivElement | null): void => {
    observer.current?.disconnect()
    observer.current = undefined
    if (node === null || typeof ResizeObserver === 'undefined') return
    const watcher = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width
      if (measured !== undefined && measured > 0) setWidth(measured)
    })
    watcher.observe(node)
    observer.current = watcher
  }, [])
  return { ref, width }
}

function lineWords(t: PanelTranslate, link: SieveHiveLink): string {
  const names = { from: link.from, to: link.to, count: link.count }
  const head = link.kind === 'delivery'
    ? t('hive.line.delivery', names)
    : link.kind === 'correction' ? t('hive.line.correction', names) : t('hive.line.conflict', names)
  return [head, ...link.texts.map(text => `· ${text}`)].join('\n')
}

const KINDS = ['delivery', 'correction', 'conflict'] as const

export function HiveGraph({ bees, links, t }: { readonly bees: readonly SieveHiveBee[], readonly links: readonly SieveHiveLink[], readonly t: PanelTranslate }): ReactNode {
  const ids = useId().replace(/:/g, '')
  const stage = useStageWidth()
  const layout = ringLayout(bees.map(bee => bee.name), stage.width)
  const drawn = links.filter(link => layout.nodes.has(link.from) && layout.nodes.has(link.to))
  const present = new Set(drawn.map(link => link.kind))
  return (
    <section className="sieve-section sieve-hive-map" aria-label={t('hive.graph')}>
      <h3>{t('hive.graph')}</h3>
      <div ref={stage.ref} className="sieve-hive-stage" style={{ height: layout.height }}>
        <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
          <defs>
            <marker id={`${ids}-arrow`} markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path className="sieve-hive-arrow" d="M0 0.5 L8 4 L0 7.5 Z" />
            </marker>
            <marker id={`${ids}-bar`} markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto">
              <path className="sieve-hive-bar" d="M5 0.5 L5 9.5" />
            </marker>
          </defs>
          {drawn.map((link) => {
            const d = linkPath(layout.nodes.get(link.from)!, layout.nodes.get(link.to)!, bendOf(link.from, link.to), link.kind === 'conflict' ? 3 : 7)
            return (
              <g key={`${link.kind}:${link.from}:${link.to}`}>
                <path
                  className="sieve-hive-line"
                  data-kind={link.kind}
                  data-from={link.from}
                  data-to={link.to}
                  data-count={link.count}
                  d={d}
                  strokeWidth={1 + Math.min(link.count - 1, 4) * 0.6}
                  markerEnd={link.kind === 'conflict' ? undefined : `url(#${ids}-arrow)`}
                  markerMid={link.kind === 'correction' ? `url(#${ids}-bar)` : undefined}
                />
                <path className="sieve-hive-hit" d={d}>
                  <title>{lineWords(t, link)}</title>
                </path>
              </g>
            )
          })}
        </svg>
        {bees.map((bee) => {
          const at = layout.nodes.get(bee.name)!
          return (
            <div
              key={bee.name}
              className="sieve-hive-node"
              data-status={bee.status}
              style={{ left: at.x - NODE_WIDTH / 2, top: at.y - AVATAR_RADIUS, width: NODE_WIDTH }}
              title={`${bee.name} · ${t(`hive.bee.${bee.status}`)}`}
            >
              <span className="sieve-hive-avatar" data-status={bee.status} style={{ width: 2 * AVATAR_RADIUS, height: 2 * AVATAR_RADIUS }}>
                {bee.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="sieve-hive-node-name" dir="auto">{bee.name}</span>
              <span className="sieve-hive-node-status">{t(`hive.bee.${bee.status}`)}</span>
              <span className="sieve-hive-node-counts">{t('hive.nodeCounts', { published: bee.published, received: bee.received })}</span>
            </div>
          )
        })}
      </div>
      <ul className="sieve-hive-legend">
        {KINDS.filter(kind => kind === 'delivery' || present.has(kind)).map(kind => (
          <li key={kind}>
            <svg width="30" height="10" viewBox="0 0 30 10" aria-hidden="true">
              <path
                className="sieve-hive-line"
                data-kind={kind}
                d={kind === 'correction' ? 'M1 5 L14 5 L27 5' : 'M1 5 L27 5'}
                strokeWidth={1.4}
                markerEnd={kind === 'conflict' ? undefined : `url(#${ids}-arrow)`}
                markerMid={kind === 'correction' ? `url(#${ids}-bar)` : undefined}
              />
            </svg>
            {t(`hive.legend.${kind}`)}
          </li>
        ))}
      </ul>
      <p className="sieve-footnote">{t('hive.graphHint')}</p>
    </section>
  )
}
