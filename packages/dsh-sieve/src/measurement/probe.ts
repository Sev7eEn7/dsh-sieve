/** Optional, host-only experiment instrumentation; never mounted by the normal bundle. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-token-meter'
import z from '@deepseek-ai/schemastery'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z as schema } from 'zod'

export interface AttemptMetric { turn: number, step: number, ttftMs: number | null, durationMs: number, committed: boolean }
export interface ProbeState { attempts: AttemptMetric[], surfaceTokens: number[], steps: number }
export const name = 'sieve-measurement'
export const inject = ['storageDomain', 'tokenMeter']
export interface Config { maxSteps: number, maxOutputTokens: number }
export const Config: z<Config> = z.object({ maxSteps: z.natural().min(1).max(500).default(30), maxOutputTokens: z.natural().min(1).default(4096) })
const domain = defineDomain({ name: 'sieve_measurement', version: 1, layout: 'per-record', invalidRecords: 'backup-and-skip',
  tables: { sessions: domainTable<string, ProbeState>(schema.custom<ProbeState>(value => typeof value === 'object' && value !== null && 'attempts' in value)) } })

export async function apply(ctx: Context, config: Config): Promise<void> {
  const store = await ctx.storageDomain.open(domain)
  const table = store.table('sessions')
  const states = new Map<string, ProbeState>()
  const live = new Map<string, { sessionId: string, turn: number, step: number, start: number, first: number | null }>()
  const entered = new WeakMap<Agent, number>()
  let writing = Promise.resolve()
  const stateOf = (id: string): ProbeState => {
    let state = states.get(id)
    if (state === undefined) { state = table.get(id) ?? { attempts: [], surfaceTokens: [], steps: 0 }; states.set(id, state) }
    return state
  }
  const save = (id: string): void => {
    const state = structuredClone(stateOf(id))
    // The domain serializes writes and drains its queue on close. Enqueue now;
    // a second, deferred queue can submit the terminal snapshot after it closes.
    writing = table.put(id, state).catch(() => { ctx.logger.warn('sieve: experiment metrics could not be saved') })
  }
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    signal.throwIfAborted()
    const state = stateOf(agent.session.header.id)
    if (state.steps >= config.maxSteps) throw new Error('sieve: experiment step budget exhausted')
    entered.set(agent, performance.now())
    const decision = await next()
    if (decision.kind === 'enter') { state.steps++; save(agent.session.header.id) }
    return decision
  }, { prepend: true })
  ctx.on('agent/request', async ({ agent }, next) => {
    const request = await next()
    const state = stateOf(agent.session.header.id)
    state.surfaceTokens.push(ctx.tokenMeter.measure(agent.session).totalTokens)
    state.surfaceTokens = state.surfaceTokens.slice(-500)
    save(agent.session.header.id)
    return { ...request, maxTokens: Math.min(request.maxTokens ?? config.maxOutputTokens, config.maxOutputTokens) }
  }, { prepend: true })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') live.set(frame.attemptId, { sessionId: agent.session.header.id, turn: frame.turn, step: frame.step, start: entered.get(agent) ?? performance.now(), first: null })
    const attempt = live.get(frame.attemptId)
    if (attempt === undefined) return
    if (frame.type === 'chunk' && ['text-delta', 'reasoning-delta', 'tool-call-delta'].includes(frame.chunk.type) && attempt.first === null) attempt.first = performance.now()
    if (frame.type !== 'end') return
    const state = stateOf(attempt.sessionId)
    state.attempts.push({ turn: attempt.turn, step: attempt.step, ttftMs: attempt.first === null ? null : attempt.first - attempt.start,
      durationMs: performance.now() - attempt.start, committed: frame.outcome.kind === 'committed' })
    state.attempts = state.attempts.slice(-500)
    live.delete(frame.attemptId)
    save(attempt.sessionId)
  })
  // This serial hook is awaited before the turn becomes idle. Persist the final
  // snapshot while the backend is live; root teardown disposes services together.
  ctx.on('agent/turn-stopping', async ({ signal }) => {
    signal.throwIfAborted()
    await writing
    signal.throwIfAborted()
  })
  ctx.effect(() => async () => { await writing; await store.close(); states.clear(); live.clear() })
}
