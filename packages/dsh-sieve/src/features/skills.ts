/**
 * Task-based skill catalog disclosure, rewritten for DSH after mu
 * packages/kyrn-judge/src/extension/features/skills.ts (MIT).
 * Copyright (c) 2025 Mario Zechner
 * See THIRD_PARTY_NOTICES.md for the source commit and license.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SkillCatalogSource } from '@deepseek-ai/dsh-tool-skill'
import { z } from 'zod'
import { skillDisclosure } from '../judge/decisions/skill-disclosure.ts'
import type { Decision } from '../judge/engine.ts'
import type { SkillDisclosureOutcome } from '../judge/decisions/skill-disclosure.ts'
import { deadline, untilAbort } from '../runtime/operations.ts'
import { textOf } from '../runtime/session-state.ts'
import type { SessionRuntime } from '../runtime/session-state.ts'
import type { AdmissionHost } from './admission.ts'

export const SKILL_STATE_KEY = 'sieve/skills'
type Entries = SkillCatalogSource['entries']

/** Metadata rides on an existing native catalog message; adapters never see it. */
declare module '@deepseek-ai/dsh-tool-skill' {
  interface SkillCatalogSource {
    readonly sieveHidden?: readonly string[]
  }
}

export interface CatalogState {
  published: boolean
  visible: { seq: number, entries: Entries } | null
  hidden: string[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'sieve/skills': CatalogState
  }
}

function fold(state: CatalogState, event: SessionEvent): CatalogState {
  const op = event.surfaceOp
  let visible = state.visible
  if (typeof op === 'object' && visible !== null && visible.seq >= op.startSeq && visible.seq <= op.endSeq) visible = null
  if (event.type === 'user/message' && event.data.source.kind === 'skill-catalog') {
    const source = event.data.source
    return { published: true, visible: { seq: event.seq, entries: source.entries }, hidden: [...source.sieveHidden ?? []] }
  }
  return visible === state.visible ? state : { ...state, visible }
}

function named(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^\\w-])${escaped}(?=$|[^\\w-])`, 'i').test(text)
}

function filterCatalog(catalog: UserMessage, hidden: ReadonlySet<string>): UserMessage {
  if (catalog.source.kind !== 'skill-catalog') return catalog
  return {
    ...catalog,
    source: { ...catalog.source, entries: catalog.source.entries.filter(entry => !hidden.has(entry.name)), sieveHidden: [...hidden] },
    content: catalog.content.map(block => block.type !== 'text' ? block : {
      ...block,
      text: block.text.split('\n').filter(line => ![...hidden].some(name => line.startsWith(`- \`${name}\`: `))).join('\n'),
    }),
  }
}

export function registerSkills(ctx: Context, host: AdmissionHost, runtime: SessionRuntime): void {
  ctx.sessionProjections.register({
    key: SKILL_STATE_KEY, stateVersion: 1,
    stateSchema: z.custom<CatalogState>(value => typeof value === 'object' && value !== null && 'published' in value),
    init: () => ({ published: false, visible: null, hidden: [] }), apply: fold,
  })
  const handled = new WeakMap<Agent, string>()
  // Applied is confirmed only once the rewritten catalog actually commits.
  const receipts = new WeakMap<Agent, { messageId: string, ledgerId: string }>()
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'skill-catalog') return
    for (const agent of ctx.get('agents')?.list() ?? []) {
      const receipt = receipts.get(agent)
      if (agent.session !== session || receipt?.messageId !== event.data.id) continue
      receipts.delete(agent)
      void host.track(host.annotate(session.header.id, receipt.ledgerId, { applied: true }))
    }
  })

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter' || !host.config.skillDisclosure.enabled) return decision
    try {
      const config = host.config.skillDisclosure
      const engine = runtime.for(agent).engine
      const mode = engine.modeOf(skillDisclosure.id)
      if (mode === 'off' || !await host.judgeReady()) return decision
      const index = decision.messages.findIndex(message => message.source.kind === 'skill-catalog')
      const catalog = decision.messages[index]
      if (catalog?.source.kind !== 'skill-catalog') return decision
      const state = ctx.sessionProjections.stateOf(agent.session, SKILL_STATE_KEY)
      if (state === undefined) return decision
      const task = runtime.task(agent)
      const incoming = [...messages].reverse().find(message => message.source.kind === 'user')
      const words = incoming === undefined ? task?.lastUser ?? '' : textOf(incoming.content)
      const requestId = incoming?.id ?? task?.userMessageId ?? ''
      const cancel = AbortSignal.any([signal, runtime.for(agent).controller.signal])
      const revision = task?.revision
      const settings = host.revisionOf(agent.session.header.id)
      const valid = (): boolean => !cancel.aborted && runtime.task(agent)?.revision === revision && host.revisionOf(agent.session.header.id) === settings
      let hidden = new Set(state.hidden.filter(name => catalog.source.kind === 'skill-catalog' && catalog.source.entries.some(entry => entry.name === name)))
      const eligible = catalog.source.entries.length >= config.minSkills && catalog.source.entries.length <= config.maxSkills && words.trim() !== ''
      const first = !state.published
      const revealNamed = [...hidden].filter(name => named(words, name) || config.alwaysVisible.includes(name))
      if (mode === 'active') for (const name of revealNamed) hidden.delete(name)
      const shouldJudge = eligible && handled.get(agent) !== requestId && (first || (incoming !== undefined && hidden.size > 0))
      let judged: Decision<SkillDisclosureOutcome> | undefined
      if (shouldJudge) {
        handled.set(agent, requestId)
        const candidates = first ? catalog.source.entries : catalog.source.entries.filter(entry => hidden.has(entry.name))
        if (candidates.length > 0) {
          // The judge splits a large catalog into requests of its own size; the catalog is still one decision.
          const input = { userMessage: words, skills: candidates }
          const work = engine.decide(skillDisclosure, input, { signal: cancel, applied: false, origin: { userMessageId: requestId, firstCatalog: first } })
          const estimate = (value: Decision<SkillDisclosureOutcome>): void => {
            if (value.ledgerId === undefined) return
            const omitted = first ? new Set(value.judged?.hide.filter(name => !named(words, name) && !config.alwaysVisible.includes(name)) ?? []) : new Set<string>()
            const chars = textOf(catalog.content).length - textOf(filterCatalog(catalog, omitted).content).length
            void host.track(host.annotate(agent.session.header.id, value.ledgerId, { savedChars: chars }))
          }
          void work.then(estimate).catch(() => {})
          if (mode === 'active') {
            const bound = deadline(cancel, config.waitMs)
            try { judged = await untilAbort(work, bound.signal) } finally { bound.dispose() }
            if (!valid()) return decision
            if (judged?.source === 'judge') {
              if (first) hidden = new Set(judged.outcome.hide.filter(name => !named(words, name) && !config.alwaysVisible.includes(name)))
              else for (const name of judged.outcome.relevant) hidden.delete(name)
            }
          }
        }
      }
      if (mode === 'shadow') return decision
      if (!valid()) return decision
      const rewritten = filterCatalog(catalog, hidden)
      const entries = rewritten.source.kind === 'skill-catalog' ? rewritten.source.entries : []
      if (state.visible !== null && JSON.stringify(entries) === JSON.stringify(state.visible.entries) && JSON.stringify([...hidden]) === JSON.stringify(state.hidden)) {
        return { ...decision, messages: decision.messages.filter((_, at) => at !== index) }
      }
      const judgeChanged = judged?.source === 'judge' && (first ? hidden.size > 0
        : state.hidden.some(name => judged.outcome.relevant.includes(name) && !hidden.has(name)))
      if (judged?.ledgerId !== undefined && judgeChanged) {
        receipts.set(agent, { messageId: rewritten.id, ledgerId: judged.ledgerId })
      }
      return { ...decision, messages: decision.messages.map((message, at) => at === index ? rewritten : message) }
    } catch {
      ctx.logger.warn('sieve: skill disclosure failed; keeping the DSH catalog')
      return decision
    }
  }, { prepend: true })
}
