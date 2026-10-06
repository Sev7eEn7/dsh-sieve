/** Native-log-derived task context, shared by resume and fork. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { DecisionEngine } from '../judge/engine.ts'

export const STATE_KEY = 'sieve/admission'

/** Match emitted archive pointer lines, not quoted source fragments. */
export function isSieveResult(text: string): boolean {
  return /^\[sieve: (?:full output: |\d+ lines omitted above as not needed for this step; full output: )[^\]\r\n]+\]\r?$/m.test(text)
}

export interface AdmissionRewrite {
  readonly sessionId: SessionId
  readonly replacement: string
  readonly records: readonly { id: string, changed: boolean }[]
}

export function textOf(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text' ? block.text : '').join('')
}

export interface TaskState {
  firstUser: string
  lastUser: string
  userMessageId: string
  revision: number
  lastAssistant: string
  reduced: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'sieve/admission': TaskState
  }
}

function fold(state: TaskState, event: SessionEvent): TaskState {
  if (event.type === 'user/message' && event.data.source.kind === 'user') {
    const text = textOf(event.data.content)
    return { ...state, firstUser: state.userMessageId === '' ? text : state.firstUser, lastUser: text, userMessageId: event.data.id, revision: event.seq, lastAssistant: '' }
  }
  // A newly queued real request invalidates a judgment even before its model-visible append.
  if (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.source.kind === 'user')) {
    return { ...state, revision: event.seq }
  }
  if (event.type === 'assistant/message') {
    const text = textOf(event.data.message.content)
    return text.trim() === '' ? state : { ...state, lastAssistant: text }
  }
  const content = event.type === 'tool/result'
    ? event.data.message.content
    : event.type === 'tool/ptc-dispatch' ? event.data.content : undefined
  return content !== undefined && isSieveResult(textOf(content)) ? { ...state, reduced: state.reduced + 1 } : state
}

export function registerTaskState(ctx: Context): void {
  ctx.sessionProjections.register({
    key: STATE_KEY,
    stateSchema: z.object({ firstUser: z.string(), lastUser: z.string(), userMessageId: z.string(), revision: z.number(), lastAssistant: z.string(), reduced: z.number() }),
    stateVersion: 3,
    init: () => ({ firstUser: '', lastUser: '', userMessageId: '', revision: -1, lastAssistant: '', reduced: 0 }),
    apply: fold,
  })
}

export interface AgentState {
  readonly controller: AbortController
  readonly engine: DecisionEngine
}

export class SessionRuntime {
  private readonly states = new WeakMap<Agent, AgentState>()
  private readonly active = new Set<AgentState>()
  private readonly engineFor: (agent: Agent) => DecisionEngine
  private readonly ctx: Context

  constructor(ctx: Context, engineFor: (agent: Agent) => DecisionEngine) {
    this.ctx = ctx
    this.engineFor = engineFor
    registerTaskState(ctx)
    ctx.on('agent/disposed', ({ agent }) => {
      const state = this.states.get(agent)
      state?.controller.abort(new Error('agent disposed'))
      if (state !== undefined) this.active.delete(state)
      this.states.delete(agent)
    })
    ctx.effect(() => () => {
      for (const state of this.active) state.controller.abort(new Error('admission unloaded'))
      this.active.clear()
    }, 'sieve.admission-lifetime')
  }

  for(agent: Agent): AgentState {
    const existing = this.states.get(agent)
    if (existing !== undefined) return existing
    const state: AgentState = { controller: new AbortController(), engine: this.engineFor(agent) }
    this.states.set(agent, state)
    this.active.add(state)
    return state
  }

  task(agent: Agent): TaskState | undefined {
    return this.ctx.sessionProjections.stateOf(agent.session, STATE_KEY)
  }
}
