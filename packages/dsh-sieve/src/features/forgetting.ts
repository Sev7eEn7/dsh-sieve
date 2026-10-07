/**
 * Batched, log-backed forgetting, rewritten for DSH after mu
 * packages/kyrn-judge/src/extension/features/forgetting.ts (MIT).
 * Copyright (c) 2025 Mario Zechner
 * See THIRD_PARTY_NOTICES.md for the source commit and license.
 *
 * Only the most recent tool results stay whole. Older ones, and reads that a
 * later read of the same lines superseded, are archived and replaced by their
 * ends and a pointer; the judge may add results inside the recent window that
 * the work has moved past. Replacing a result breaks the cached prefix from
 * there on, so replacements wait until one batch saves `minBatchChars`, and a
 * batch lands before one request. mu forgot only past 50/70/85% of the context
 * window: on public SWE trajectories most tasks never got there, while a batch
 * of old results pays for its cache rebuild within a few requests.
 */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, ToolResultMessage } from '@deepseek-ai/dsh-session'
import { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate'
import { z } from 'zod'
import { contextForget } from '../judge/decisions/context-forget.ts'
import type { Decision } from '../judge/engine.ts'
import type { ForgetOutcome } from '../judge/decisions/context-forget.ts'
import { deadline, untilAbort } from '../runtime/operations.ts'
import { textOf } from '../runtime/session-state.ts'
import type { SessionRuntime } from '../runtime/session-state.ts'
import type { AdmissionHost } from './admission.ts'
import { FULL_OUTPUT_REQUEST, referencedCalls } from './admission-rules.ts'

export const FORGET_STATE_KEY = 'sieve/forgetting'
/** The pointer line of a forgotten result; `at N%` is the marker version 1 wrote. */
const FORGOTTEN = /^\[sieve: forgotten(?: at [\d,]+%|, superseded by a later read)?; full output: [^\]\r\n]+\]\r?$/m
/** Shorter results are not tracked: forgetting them would save nothing. */
const MIN_TRACKED_CHARS = 300
/** The judge is asked about results inside the recent window that at least this many later results follow. */
const JUDGE_MIN_AGE = 2
const PREVIEW_CHARS = 300

interface Call {
  id: string
  name: string
  arguments: string
}

export interface ForgetCandidate {
  seq: number
  data: SessionEvent<'tool/result'>['data']
  call: Call | null
  /** This result's number among the session's tool results; each later result makes it one older. */
  ordinal: number
  chars: number
}

/** A visible result that refers to earlier outputs instead of repeating them. */
export interface Reference {
  seq: number
  calls: string[]
}

export interface ForgetState {
  candidates: ForgetCandidate[]
  /** While a reference is visible, the output it points to is not forgotten. */
  references: Reference[]
  calls: Call[]
  /** Tool results seen, replacements not counted. */
  results: number
  epoch: number
  since: string[]
  forgotten: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'sieve/forgetting': ForgetState
  }
}

export interface ReadRange {
  /** Working directory and resolved path. */
  readonly identity: string
  readonly first: number
  readonly last: number
}

const READ_FOOTER = /\n\n\((?:End of file - total \d+ lines|Showing lines \d+-\d+ of \d+\. Use offset=\d+ to continue\.|Output capped\. Showing lines \d+-\d+\. Use offset=\d+ to continue\.)\)$/

/**
 * The file and the line range a DSH read showed, from its arguments and its
 * envelope. Undefined for anything else, and for a read whose numbered lines
 * do not run without a gap, such as one admission already shortened.
 */
export function readRange(candidate: ForgetCandidate, cwd: string): ReadRange | undefined {
  if (candidate.call?.name !== 'read' || candidate.data.message.isError) return undefined
  let args: unknown
  try { args = JSON.parse(candidate.call.arguments) } catch { return undefined }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const input = args as Record<string, unknown>
  if (typeof input['file_path'] !== 'string' || Object.keys(input).some(key => !['file_path', 'offset', 'limit'].includes(key))) return undefined
  const text = textOf(candidate.data.message.content)
  const match = /^<path>([^\n]+)<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/.exec(text)
  if (match === null || resolve(cwd, match[1] ?? '') !== resolve(cwd, input['file_path'])) return undefined
  const body = match[2] ?? ''
  const footer = READ_FOOTER.exec(body)
  if (footer === null) return undefined
  const lines = body.slice(0, footer.index).split('\n')
  const numbers = lines.map(line => /^(\d+): /.exec(line)?.[1])
  const first = Number(numbers[0])
  if (numbers.some((value, index) => value === undefined || Number(value) !== first + index)) return undefined
  return { identity: JSON.stringify({ cwd: resolve(cwd), path: resolve(cwd, input['file_path']) }), first, last: first + numbers.length - 1 }
}

function folded(state: ForgetState, event: SessionEvent, cap: number, budget: number): ForgetState {
  const op = event.surfaceOp
  const replaced = typeof op !== 'object' ? [] : state.candidates.filter(candidate => candidate.seq >= op.startSeq && candidate.seq <= op.endSeq)
  if (replaced.length > 0) state = { ...state, candidates: state.candidates.filter(candidate => !replaced.includes(candidate)) }
  if (typeof op === 'object' && state.references.some(reference => reference.seq >= op.startSeq && reference.seq <= op.endSeq)) {
    state = { ...state, references: state.references.filter(reference => reference.seq < op.startSeq || reference.seq > op.endSeq) }
  }
  if (event.type === 'assistant/message') {
    const text = textOf(event.data.message.content).replace(/\s+/g, ' ').slice(0, 160)
    return text === '' ? state : { ...state, since: [...state.since, text].slice(-4) }
  }
  if (event.type === 'tool/call') {
    const { callId, name, arguments: args } = event.data
    return { ...state, calls: [...state.calls, { id: callId, name, arguments: args.length <= 8000 ? args : '' }].slice(-cap) }
  }
  if (event.type === 'compaction/end' && event.data.error === undefined) return { ...state, epoch: event.seq }
  if (event.type !== 'tool/result') return state
  const callId = event.data.message.toolCallId
  // A replacement (a pruner's, sieve's own) stands where the result it replaces stood.
  const before = replaced.find(candidate => candidate.data.message.toolCallId === callId)
  const call = state.calls.find(item => item.id === callId) ?? before?.call ?? null
  const calls = state.calls.filter(item => item.id !== callId)
  const results = typeof op === 'object' ? state.results : state.results + 1
  const text = textOf(event.data.message.content)
  if (FORGOTTEN.test(text)) return { ...state, calls, results, forgotten: state.forgotten + 1 }
  const pointed = referencedCalls(text)
  if (pointed.length > 0) state = { ...state, references: [...state.references, { seq: event.seq, calls: pointed }].slice(-cap) }
  if (event.data.message.isError || event.data.message.content.some(block => block.type !== 'text') || text.length < MIN_TRACKED_CHARS || text.length > budget) {
    return { ...state, calls, results }
  }
  const ordinal = before?.ordinal ?? results
  const retained = [...state.candidates, { seq: event.seq, data: event.data, call, ordinal, chars: text.length }].slice(-cap)
  let total = retained.reduce((sum, candidate) => sum + candidate.chars, 0)
  while (total > budget && retained.length > 0) total -= retained.shift()?.chars ?? 0
  return { ...state, calls, results, candidates: retained }
}

/** A result's start and end around the pointer; a superseded read keeps only the pointer. */
function replacement(candidate: ForgetCandidate, superseded: boolean, edge: number, locator: string, hint = ''): string {
  const pointer = `[sieve: forgotten${superseded ? ', superseded by a later read' : ''}; full output: ${locator}]\n${hint === '' ? '' : `${hint}\n`}`
  if (superseded) return pointer
  // By code point, so surrogate pairs cannot split.
  const points = Array.from(textOf(candidate.data.message.content))
  return `${points.slice(0, edge).join('')}\n${pointer}${edge === 0 ? '' : points.slice(-edge).join('')}`
}

function preview(candidate: ForgetCandidate): string {
  const points = Array.from(textOf(candidate.data.message.content))
  if (points.length <= 2 * PREVIEW_CHARS) return points.join('')
  return `${points.slice(0, PREVIEW_CHARS).join('')}\n[${points.length - 2 * PREVIEW_CHARS} characters not shown]\n${points.slice(-PREVIEW_CHARS).join('')}`
}

export function registerForgetting(ctx: Context, host: AdmissionHost, runtime: SessionRuntime): void {
  const config = host.config.forgetting
  ctx.sessionProjections.register({
    key: FORGET_STATE_KEY, stateVersion: 2,
    stateSchema: z.custom<ForgetState>(value => typeof value === 'object' && value !== null && 'candidates' in value && 'references' in value),
    init: () => ({ candidates: [], references: [], calls: [], results: 0, epoch: -1, since: [], forgotten: 0 }),
    apply: (state, event) => folded(state, event, config.maxTrackedResults, config.maxStateChars),
  })
  /**
   * Results already forgotten by rule, or asked about, in this epoch: shadow
   * records each once, and a failed archive is not retried every step. A
   * result the judge kept still ages into the rules.
   */
  const batched = new WeakMap<Agent, { epoch: number, settings: number, ruled: Set<number>, asked: Set<number> }>()
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const run = async (): Promise<void> => {
      // Checked first: the projection read below must not go stale across the await.
      if (!await host.judgeReady()) return
      const state = ctx.sessionProjections.stateOf(agent.session, FORGET_STATE_KEY)
      const task = runtime.task(agent)
      const agentState = runtime.for(agent)
      const mode = agentState.engine.modeOf(contextForget.id)
      if (!config.enabled || mode === 'off' || state === undefined || task === undefined) return
      const request = [...messages].reverse().find(message => message.source.kind === 'user')
      const current = request === undefined ? task.lastUser : textOf(request.content)
      if (current.trim() === '' || FULL_OUTPUT_REQUEST.test(`${current}\n${request === undefined ? task.lastAssistant : ''}`)) return
      const cancel = AbortSignal.any([signal, agentState.controller.signal])
      const revision = task.revision
      const settings = host.revisionOf(agent.session.header.id)
      const epoch = state.epoch
      const valid = (): boolean => !cancel.aborted && runtime.task(agent)?.revision === revision
        && host.revisionOf(agent.session.header.id) === settings && ctx.sessionProjections.stateOf(agent.session, FORGET_STATE_KEY)?.epoch === epoch
      let done = batched.get(agent)
      if (done === undefined || done.epoch !== epoch || done.settings !== settings) {
        done = { epoch, settings, ruled: new Set(), asked: new Set() }
        batched.set(agent, done)
      }
      const { ruled, asked: judgedBefore } = done

      const onSurface = (seq: number): boolean => agent.session.surface.nodes.includes(SessionSeq(seq))
      // A visible reference points into its source: forgetting the source would lose what the reference stands for.
      const referenced = new Set(state.references.filter(reference => onSurface(reference.seq)).flatMap(reference => reference.calls))
      const visible = state.candidates.filter(candidate => onSurface(candidate.seq) && !referenced.has(candidate.data.message.toolCallId))
      const age = (candidate: ForgetCandidate): number => state.results - candidate.ordinal
      const cwd = agent.session.header.cwd ?? '.'
      const ranges = new Map(visible.map(candidate => [candidate.seq, readRange(candidate, cwd)]))
      const superseded = new Set(visible.filter((candidate, index) => {
        const range = ranges.get(candidate.seq)
        return range !== undefined && visible.slice(index + 1).some(later => {
          const cover = ranges.get(later.seq)
          return cover?.identity === range.identity && cover.first <= range.first && cover.last >= range.last
        })
      }).map(candidate => candidate.seq))
      const estimate = (candidate: ForgetCandidate): number =>
        Math.max(0, candidate.chars - replacement(candidate, superseded.has(candidate.seq), config.edgeChars, '<archive>').length)
      const rules = visible.filter(candidate => !ruled.has(candidate.seq) && estimate(candidate) > 0
        && (superseded.has(candidate.seq) || (age(candidate) >= config.keepRecent && candidate.chars >= config.minChars)))
      // One cache rebuild has to buy enough: below this the results wait for the next batch.
      if (rules.reduce((sum, candidate) => sum + estimate(candidate), 0) < config.minBatchChars) return
      const batch = rules.slice(0, config.maxPerBatch)
      const asked = visible.filter(candidate => !ruled.has(candidate.seq) && !judgedBefore.has(candidate.seq) && !rules.includes(candidate)
        && candidate.call?.name !== 'read' && age(candidate) >= JUDGE_MIN_AGE && candidate.chars >= config.minChars && estimate(candidate) > 0)
      for (const candidate of batch) ruled.add(candidate.seq)
      for (const candidate of asked) judgedBefore.add(candidate.seq)

      const origin = { userMessageId: request?.id ?? task.userMessageId, results: state.results, keepRecent: config.keepRecent }
      const rulesId = agentState.engine.recordRules(contextForget, {
        state: { superseded: batch.filter(candidate => superseded.has(candidate.seq)).map(candidate => candidate.seq), aged: batch.filter(candidate => !superseded.has(candidate.seq)).map(candidate => candidate.seq) },
        outcome: { forget: batch.map(candidate => candidate.seq) },
        origin, applied: false, savedChars: batch.reduce((sum, candidate) => sum + estimate(candidate), 0),
      })
      const bound = deadline(cancel, config.waitMs)
      let judging: Promise<Decision<ForgetOutcome>[]> | undefined
      try {
        if (asked.length > 0) {
          const goal = [...new Set([task.firstUser, current].filter(Boolean))].join('\n')
          judging = agentState.engine.decideMany(contextForget, asked.map(candidate => ({
            goal, call: `${candidate.call?.name ?? 'tool'}: ${candidate.call?.arguments ?? ''}`.slice(0, 500),
            resultChars: candidate.chars, resultsSince: age(candidate), since: state.since, preview: preview(candidate),
          })), { signal: mode === 'shadow' ? cancel : bound.signal, applied: false, origin })
          void judging.then(decisions => {
            const id = decisions[0]?.ledgerId
            if (id === undefined) return
            const savedChars = decisions.reduce((sum, decision, index) => sum + (decision.judged === 'shrink' && asked[index] !== undefined ? estimate(asked[index]) : 0), 0)
            void host.track(host.annotate(agent.session.header.id, id, { savedChars }))
          }).catch(() => {})
        }
        if (mode === 'shadow') return
        const apply = async (selected: readonly ForgetCandidate[]): Promise<boolean> => {
          let applied = false
          for (const candidate of selected) {
            if (!valid() || bound.signal.aborted || !agent.session.surface.nodes.includes(SessionSeq(candidate.seq))) break
            let ref
            try {
              ref = await untilAbort(host.track(ctx.spillStore.saveText({ owner: { sessionId: agent.session.header.id },
                source: { kind: 'tool', toolName: candidate.call?.name ?? 'tool', callId: candidate.data.message.toolCallId, label: 'sieve-forgotten' },
                suggestedName: 'forgotten-output.txt', content: textOf(candidate.data.message.content),
              })), bound.signal)
            } catch { ctx.logger.warn('sieve: archive failed; keeping this tool result'); continue }
            if (ref === undefined || !valid() || !agent.session.surface.nodes.includes(SessionSeq(candidate.seq))) continue
            const text = replacement(candidate, superseded.has(candidate.seq), config.edgeChars, ref.locator, ref.retrievalHint)
            if (text.length >= candidate.chars) continue
            const seq = SessionSeq(candidate.seq)
            agent.session.append('compaction/prune', { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: estimateMessage(candidate.data.message) })
            agent.session.append('tool/result', { ...candidate.data, message: freezeMessage<ToolResultMessage>({ ...candidate.data.message, content: [{ type: 'text', text }] }) }, {
              surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
            })
            applied = true
          }
          return applied
        }
        // The rules get their archive budget even if the judge times out.
        const rulesApplied = await apply(batch)
        if (rulesId !== undefined) void host.track(host.annotate(agent.session.header.id, rulesId, { applied: rulesApplied }))
        const judged = judging === undefined ? undefined : await untilAbort(judging, bound.signal)
        if (!valid() || judged === undefined) return
        const judgeApplied = await apply(asked.filter((_, index) => judged[index]?.outcome === 'shrink'))
        const judgeId = judged[0]?.ledgerId
        if (judgeId !== undefined) void host.track(host.annotate(agent.session.header.id, judgeId, { applied: judgeApplied }))
      } finally { bound.dispose() }
    }
    try { await run() } catch {
      ctx.logger.warn('sieve: forgetting failed; keeping the current context')
    }
    return next()
  }, { prepend: true })
}
