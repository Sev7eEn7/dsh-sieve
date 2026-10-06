/** The sieve tab body: the session's context reduction and the Jev keys the judge uses. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconRefreshOutlineRegular, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { JevKeyInfo, JevService, SieveJudgeStatus, SieveReduction } from 'dsh-sieve/status'
import { API_KEY_LENGTH } from '../protocol.ts'
import { count, percent } from './format.ts'
import type { PanelError, PanelSource, PanelState } from './source.ts'

/** How often a visible panel re-reads while its session runs. */
export const POLL_MS = 3000

/** Translate function of the panel namespace. */
export type PanelTranslate = PropsLocale<'sieve'>['t']

/** What the plugin injects into the tab body. */
export interface SievePanelInjected {
  readonly hooks: { readonly panel: Pick<PanelSource, 'getSnapshot' | 'subscribe'> }
  readonly refresh: () => Promise<void>
  readonly setKey: (service: JevService, apiKey: string | null) => Promise<boolean>
}

export type SievePanelProps = Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'useSession' | 'useTabInfo'>
  & InjectFace<SievePanelInjected> & PropsLocale<'sieve'>

/**
 * Bind the session's view to the panel: read when the tab becomes visible or
 * the session starts or stops, poll while it runs, and answer the page refresh command.
 * @param props - framework hooks, the injected source and callbacks, and `t`.
 * @returns the panel.
 */
export function SievePanel(props: SievePanelProps): ReactNode {
  const { refresh, setKey, t } = props
  const info = props.useTabInfo()
  const visible = info.tab.visible
  const actions = info.tab.actions
  // Annotated: the Session snapshot type lives in a package this one does not install for one field.
  const running = props.useSession((session: { readonly running: boolean }) => session.running)
  const state = props.usePanel(snapshot => snapshot)
  useEffect(() => actions.bindCommands({ refresh: () => { void refresh() } }), [actions, refresh])
  useEffect(() => {
    if (visible) void refresh()
  }, [visible, running, refresh])
  useEffect(() => {
    if (!visible || !running) return undefined
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [visible, running, refresh])
  return <PanelView state={state} t={t} onRefresh={() => { void refresh() }} onSaveKey={setKey} />
}

export interface PanelViewProps {
  readonly state: PanelState
  readonly t: PanelTranslate
  readonly onRefresh: () => void
  readonly onSaveKey: (service: JevService, apiKey: string | null) => Promise<boolean>
}

function errorText(t: PanelTranslate, error: PanelError): string {
  switch (error.kind) {
    case 'unavailable': return t('error.unavailable')
    case 'rejected': return t('error.rejected', { message: `${error.code}: ${error.message}` })
    case 'version': return t('error.version')
  }
}

/**
 * The panel without framework hooks, so it renders from plain props.
 * @param props - panel state, `t`, and the refresh and key callbacks.
 * @returns the panel markup.
 */
export function PanelView({ state, t, onRefresh, onSaveKey }: PanelViewProps): ReactNode {
  const view = state.view
  return (
    <div className="sieve-panel" aria-busy={state.loading}>
      <div className="sieve-header">
        <span className="sieve-title">{t('tab.title')}</span>
        <Button size="sm" variant="ghost" aria-label={t('header.refresh')} title={t('header.refresh')} onClick={onRefresh}>
          <IconRefreshOutlineRegular />
        </Button>
      </div>
      {state.error === undefined ? undefined : <div className="sieve-error" role="alert">{errorText(t, state.error)}</div>}
      {view === undefined
        ? (state.error === undefined ? <div className="sieve-notice">{t('state.loading')}</div> : undefined)
        : (
          <>
            <Metrics reduction={view.reduction} t={t} />
            <JevKeys judge={view.judge} saving={state.saving} t={t} onSaveKey={onSaveKey} />
          </>
        )}
    </div>
  )
}

function Metrics({ reduction, t }: { readonly reduction: SieveReduction, readonly t: PanelTranslate }): ReactNode {
  return (
    <dl className="sieve-metrics">
      <div className="sieve-metric" data-metric="tokens" title={t('metric.tokensHint', { density: reduction.charsPerToken })}>
        <dt>{t('metric.tokens')}</dt>
        <dd>{count(reduction.tokens)}</dd>
        <dd className="sieve-metric-sub">{reduction.ratio === null ? t('metric.ratioUnknown') : t('metric.ratio', { ratio: percent(reduction.ratio) })}</dd>
      </div>
      <div className="sieve-metric" data-metric="context" title={t('metric.contextHint')}>
        <dt>{t('metric.context')}</dt>
        <dd>{t('metric.chars', { chars: count(reduction.chars) })}</dd>
      </div>
    </dl>
  )
}

interface JevKeysProps {
  readonly judge: SieveJudgeStatus
  readonly saving: JevService | undefined
  readonly t: PanelTranslate
  readonly onSaveKey: PanelViewProps['onSaveKey']
}

function usingText(t: PanelTranslate, using: SieveJudgeStatus['using']): string {
  if (using.kind === 'off') return t('jev.using.off')
  if (using.kind === 'llm') return t('jev.using.llm')
  return using.service === null ? t('jev.using.jevUnknown') : t('jev.using.jev', { service: t(`jev.service.${using.service}`) })
}

function JevKeys({ judge, saving, t, onSaveKey }: JevKeysProps): ReactNode {
  return (
    <section className="sieve-section" aria-labelledby="sieve-jev-title">
      <h3 id="sieve-jev-title">{t('jev.title')}</h3>
      <p className="sieve-detail" data-using={judge.using.kind}>{usingText(t, judge.using)}</p>
      {judge.type === 'auto' ? undefined : <div className="sieve-notice">{t('jev.profileJudge', { type: judge.type })}</div>}
      {judge.keys.map(info => <KeyRow key={info.service} info={info} saving={saving} t={t} onSaveKey={onSaveKey} />)}
      <p className="sieve-footnote">{t('jev.note')}</p>
    </section>
  )
}

interface KeyRowProps {
  readonly info: JevKeyInfo
  readonly saving: JevService | undefined
  readonly t: PanelTranslate
  readonly onSaveKey: PanelViewProps['onSaveKey']
}

/** Source layers DSH's local credential provider reports; others show as given. */
const SOURCES = ['env', 'file', 'project-env', 'user-env'] as const

function sourceText(t: PanelTranslate, source: string | null): string {
  const known = SOURCES.find(candidate => candidate === source)
  return known === undefined ? source ?? '' : t(`jev.source.${known}`)
}

function validKey(value: string): boolean {
  return value.length >= API_KEY_LENGTH.min && value.length <= API_KEY_LENGTH.max && /^\S+$/.test(value)
}

function KeyRow({ info, saving, t, onSaveKey }: KeyRowProps): ReactNode {
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)
  const service = t(`jev.service.${info.service}`)
  const busy = saving !== undefined
  const save = (): void => {
    const value = draft.trim()
    if (!validKey(value)) { setInvalid(true); return }
    setInvalid(false)
    void onSaveKey(info.service, value).then((saved) => { if (saved) setDraft('') })
  }
  return (
    <div className="sieve-key" data-service={info.service} data-configured={info.configured}>
      <div className="sieve-key-head">
        <span className="sieve-key-name">{service}</span>
        <span className="sieve-detail">
          {info.configured ? t('jev.configured', { source: sourceText(t, info.source) }) : t('jev.notConfigured')}
        </span>
      </div>
      {info.configured && info.writable && info.source !== 'file'
        ? <p className="sieve-detail">{t('jev.fallback', { ref: info.ref, source: sourceText(t, info.source) })}</p>
        : undefined}
      {!info.writable
        ? <p className="sieve-detail">{info.configured ? t('jev.readOnly', { ref: info.ref }) : t('jev.unavailable')}</p>
        : (
          <form
            className="sieve-key-form"
            onSubmit={(event) => { event.preventDefault(); save() }}
          >
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label={t('jev.inputLabel', { service })}
              aria-invalid={invalid}
              placeholder={t('jev.placeholder')}
              value={draft}
              disabled={busy}
              onChange={(event) => { setDraft(event.currentTarget.value); setInvalid(false) }}
            />
            <Button type="submit" size="sm" variant="primary" disabled={busy || draft.trim() === ''}>
              {info.configured ? t('jev.replace') : t('jev.save')}
            </Button>
            {/* Only the managed store can be cleared from here; a .env key stays until its file changes. */}
            {info.configured && info.source === 'file'
              ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { void onSaveKey(info.service, null) }}>{t('jev.clear')}</Button>
              : undefined}
          </form>
        )}
      {invalid ? <p className="sieve-error-text" role="alert">{t('jev.invalid', { min: API_KEY_LENGTH.min, max: API_KEY_LENGTH.max })}</p> : undefined}
    </div>
  )
}
