/** Optional, host-only experiment instrumentation; never mounted by the normal bundle. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-token-meter'
import z from '@deepseek-ai/schemastery'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z as schema } from 'zod'

export interface AttemptMetric { turn: number, step: number, ttftMs: number | null, durationMs: number, committed: boolean, eventSeq?: number, finish?: string }
export interface ProbeState { attempts: AttemptMetric[], surfaceTokens: number[], steps: number, stepLimitReached?: boolean }
/**
 * One provider Messages request seen on the wire. Holds request settings and
 * the model id the provider answered with; never headers or message content.
 */
export interface WireRecord {
  time: string
  /** `main` requests carry tool schemas; sieve's judge requests carry none. */
  role: 'main' | 'judge'
  requestModel: string | null
  responseModel: string | null
  status: number
  settings: Record<string, unknown>
  systemChars: number
  messages: number
  tools: number
}
export interface WireState { records: WireRecord[] }
export const name = 'sieve-measurement'
export const inject = ['storageDomain', 'tokenMeter', 'llm', 'systemPrompt']
export interface Config { maxSteps: number, maxOutputTokens: number, nonce?: string, observeWire: boolean, preflight: boolean }
export const Config: z<Config> = z.object({
  maxSteps: z.natural().min(1).max(500).default(30),
  maxOutputTokens: z.natural().min(1).default(4096),
  nonce: z.string(),
  observeWire: z.boolean().default(false),
  preflight: z.boolean().default(false),
})
const domain = defineDomain({ name: 'sieve_measurement', version: 2, layout: 'per-record', invalidRecords: 'backup-and-skip',
  tables: {
    sessions: domainTable<string, ProbeState>(schema.custom<ProbeState>(value => typeof value === 'object' && value !== null && 'attempts' in value)),
    wire: domainTable<string, WireState>(schema.custom<WireState>(value => typeof value === 'object' && value !== null && 'records' in value)),
  } })
/** Placed before DSH's harness identity (-1000), so the nonce leads the cached prefix. */
const NONCE_ORDER = -2000

export async function apply(ctx: Context, config: Config): Promise<void> {
  // Keyless real-CLI preflight: one scripted build call, then a final answer.
  if (config.preflight) ctx.llm.registerAdapter(['sieve-preflight'], new PreflightAdapter())
  if (config.nonce !== undefined) {
    const nonce = config.nonce
    ctx.effect(() => ctx.systemPrompt.section({ name: 'sieve-measurement-nonce', order: NONCE_ORDER, text: `Measurement run ${nonce}.`, interpolate: false }))
  }
  const store = await ctx.storageDomain.open(domain)
  const table = store.table('sessions')
  const wireTable = store.table('wire')
  const wire: WireState = { records: [] }
  const wireKey = randomUUID()
  const states = new Map<string, ProbeState>()
  const live = new Map<string, { sessionId: string, turn: number, step: number, start: number, first: number | null, finish?: string }>()
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
  if (config.observeWire) observeWire(ctx, value => {
    wire.records.push(value)
    writing = wireTable.put(wireKey, structuredClone(wire)).catch(() => { ctx.logger.warn('sieve: experiment wire records could not be saved') })
  })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    signal.throwIfAborted()
    const state = stateOf(agent.session.header.id)
    if (state.steps >= config.maxSteps) { state.stepLimitReached = true; save(agent.session.header.id); throw new Error('sieve: experiment step budget exhausted') }
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
    return { ...request, ...config.preflight ? { provider: 'sieve-preflight', model: 'keyless' } : {},
      maxTokens: Math.min(request.maxTokens ?? config.maxOutputTokens, config.maxOutputTokens) }
  }, { prepend: true })
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (frame.type === 'start') live.set(frame.attemptId, { sessionId: agent.session.header.id, turn: frame.turn, step: frame.step, start: entered.get(agent) ?? performance.now(), first: null })
    const attempt = live.get(frame.attemptId)
    if (attempt === undefined) return
    if (frame.type === 'chunk' && ['text-delta', 'reasoning-delta', 'tool-call-delta'].includes(frame.chunk.type) && attempt.first === null) attempt.first = performance.now()
    if (frame.type === 'chunk' && frame.chunk.type === 'finish') attempt.finish = frame.chunk.reason.kind
    if (frame.type !== 'end') return
    const state = stateOf(attempt.sessionId)
    state.attempts.push({ turn: attempt.turn, step: attempt.step, ttftMs: attempt.first === null ? null : attempt.first - attempt.start,
      durationMs: performance.now() - attempt.start, committed: frame.outcome.kind === 'committed',
      ...frame.outcome.kind === 'committed' ? { eventSeq: frame.outcome.seq } : {},
      ...attempt.finish === undefined ? {} : { finish: attempt.finish } })
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

/**
 * Tee provider Messages responses to read the answering model id. DSH's
 * DeepSeek adapter keeps only the requested id, and the measurement must
 * notice a provider-side model change. Restored on dispose.
 */
function observeWire(ctx: Context, record: (value: WireRecord) => void): void {
  ctx.effect(() => {
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const response = await original(input, init)
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.endsWith('/messages') || init?.method !== 'POST' || typeof init.body !== 'string' || response.body === null) return response
      let body: Record<string, unknown>
      try { body = JSON.parse(init.body) as Record<string, unknown> } catch { return response }
      // Allowlist: the DSH request body also carries the session log, which is content.
      const settings = Object.fromEntries(Object.entries(body).filter(([key]) => WIRE_SETTINGS.includes(key)))
      const tools = Array.isArray(body.tools) ? body.tools.length : 0
      const base = { time: new Date().toISOString(), role: tools > 0 ? 'main' : 'judge', requestModel: typeof body.model === 'string' ? body.model : null,
        status: response.status, settings, systemChars: JSON.stringify(body.system ?? '').length,
        messages: Array.isArray(body.messages) ? body.messages.length : 0, tools } as const
      // Inspect the very stream the adapter reads: a tee branch loses its queue when DSH aborts the request after the last event.
      let done = false
      const finish = (model: string | null): void => { if (!done) { done = true; record({ ...base, responseModel: model }) } }
      const scan = modelScanner()
      init.signal?.addEventListener('abort', () => finish(null), { once: true })
      const inspected = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (!done) { const model = scan(chunk); if (model !== null) finish(model) }
          controller.enqueue(chunk)
        },
        flush() { finish(null) },
      }))
      return new Response(inspected, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
    return () => { globalThis.fetch = original }
  })
}
const WIRE_SETTINGS = ['model', 'stream', 'max_tokens', 'thinking', 'output_config', 'temperature', 'top_p', 'top_k', 'tool_choice', 'stop_sequences']

/** Incremental SSE scan for `message_start.message.model`; returns null until found. */
export function modelScanner(): (chunk: Uint8Array) => string | null {
  const decoder = new TextDecoder()
  let pending = ''
  return chunk => {
    pending += decoder.decode(chunk, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    if (pending.length > 1_000_000) pending = ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      try {
        const event = JSON.parse(line.slice(5)) as { type?: string, message?: { model?: unknown } }
        if (event.type === 'message_start' && typeof event.message?.model === 'string') return event.message.model
      } catch { /* not JSON */ }
    }
    return null
  }
}

class PreflightAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    // One-turn preflight: user-role context snapshots can follow the tool result, so any tool result ends it.
    if (!options.messages.some(message => message.role === 'tool')) {
      const id = ToolCallId(`preflight-${randomUUID()}`)
      const args = JSON.stringify({ command: 'npm run build', description: 'Run the fixture build' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'bash', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bash', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'preflight done without a model call' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'preflight done without a model call' } }
    yield { type: 'usage', usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
