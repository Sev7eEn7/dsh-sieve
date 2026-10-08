/**
 * Runs decisions fail-open: `decide` never rejects because of the judge.
 * Off, no judge, timeouts, outages, invalid answers and abstentions all yield
 * the spec's fallback. Every judged decision is written to the ledger with its
 * complete usage.
 *
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * The engine holds no mode table and no judge
 * registry: the host answers `mode(specId)` and `judge(specId)` from its
 * configuration, so a mode change or a new route needs no engine of its own.
 * @module
 */

import { createHash, randomUUID } from 'node:crypto'
import { ABSTAIN } from './decision.ts'
import type { DecisionMode, DecisionSpec } from './decision.ts'
import { isJudgeError } from './errors.ts'
import type { Inflight } from './inflight.ts'
import type { JudgeLike } from './judge.ts'
import type { LedgerRecord, LedgerSink } from './ledger.ts'
import { LEDGER_RECORD_VERSION } from './ledger.ts'
import { environmentSecrets, redactJson } from './redact.ts'
import { addUsage } from './types.ts'
import type { Answer, AnswersFor, JsonValue, JudgeInput, JudgeUsage, JudgeWarning, Questions } from './types.ts'

/** Batches up to this size keep each item's answers in their ledger record. */
const MAX_BATCH_ANSWERS = 8

export interface DecisionEngineOptions {
  /** The judge for a decision, or undefined when none is configured. */
  readonly judge: JudgeLike | ((specId: string) => JudgeLike | undefined) | undefined
  /** The mode for a decision. Default: shadow everywhere. */
  readonly mode?: ((specId: string) => DecisionMode) | undefined
  readonly ledger?: LedgerSink | undefined
  /** Store submitted states in the ledger. Off by default because states can hold user content. */
  readonly recordState?: boolean | undefined
  /**
   * Values taken out of everything a judge is shown, wherever they appear.
   * Default: this process's credential variables. Tokens in a shape only
   * credentials have go whatever this returns.
   */
  readonly knownSecrets?: (() => readonly string[]) | undefined
  /** Aborts every judge call of this engine, e.g. when the host unloads. */
  readonly signal?: AbortSignal | undefined
  /** Tracks every decision until its ledger write settles, so the host can wait for both before closing the ledger. */
  readonly inflight?: Inflight | undefined
}

export interface DecideOptions {
  readonly signal?: AbortSignal | undefined
  /** Hosts initialize receipts before doing fallible archive or publication work. */
  readonly applied?: false | undefined
  /** Stored with the ledger record: where the caller was when it asked, such as a tool call id. */
  readonly origin?: JsonValue | undefined
}

export interface Decision<Out> {
  readonly specId: string
  readonly mode: DecisionMode
  /** What the caller must act on. */
  readonly outcome: Out
  readonly source: 'judge' | 'fallback'
  /** Why the fallback was used: "off", "no-judge", "shadow", "abstain", or "error:<kind>". */
  readonly reason?: string | undefined
  /** What the judge path produced; undefined when it abstained or the call failed. */
  readonly judged?: Out | undefined
  readonly answers?: Readonly<Record<string, Answer>> | undefined
  readonly latencyMs?: number | undefined
  readonly usage?: JudgeUsage | undefined
  readonly warnings?: readonly JudgeWarning[] | undefined
  readonly ledgerId?: string | undefined
}

interface Evaluation<Out> {
  judged?: Out | undefined
  answers?: Readonly<Record<string, Answer>> | undefined
  latencyMs?: number | undefined
  usage?: JudgeUsage | undefined
  /** The provider that answered, which may differ from the judge's own id when it delegates per call. */
  providerId?: string | undefined
  modelId?: string | undefined
  warnings?: readonly JudgeWarning[] | undefined
  failure?: string | undefined
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class DecisionEngine {
  private readonly judge: DecisionEngineOptions['judge']
  private readonly mode: (specId: string) => DecisionMode
  private readonly ledger: LedgerSink | undefined
  private readonly recordState: boolean
  private readonly knownSecrets: () => readonly string[]
  private readonly signal: AbortSignal | undefined
  private readonly inflight: Inflight | undefined

  constructor(options: DecisionEngineOptions) {
    this.judge = options.judge
    this.mode = options.mode ?? (() => 'shadow')
    this.ledger = options.ledger
    this.recordState = options.recordState ?? false
    this.knownSecrets = options.knownSecrets ?? (() => environmentSecrets())
    this.signal = options.signal
    this.inflight = options.inflight
  }

  private track<T>(work: Promise<T>): Promise<T> {
    return this.inflight === undefined ? work : this.inflight.track(work)
  }

  modeOf(specId: string): DecisionMode {
    return this.mode(specId)
  }

  judgeFor(specId: string): JudgeLike | undefined {
    return typeof this.judge === 'function' ? this.judge(specId) : this.judge
  }

  private signalFor(signal: AbortSignal | undefined): AbortSignal | undefined {
    const signals = [signal, this.signal].filter((item): item is AbortSignal => item !== undefined)
    if (signals.length <= 1) return signals[0]
    return AbortSignal.any(signals)
  }

  private async evaluate<In, const Qs extends Questions, Out extends JsonValue>(
    judge: JudgeLike,
    spec: DecisionSpec<In, Qs, Out>,
    input: In,
    state: JudgeInput,
    signal: AbortSignal | undefined,
  ): Promise<Evaluation<Out>> {
    const questions: Questions = spec.questionsFor === undefined ? spec.questions : spec.questionsFor(input)
    if (Object.keys(questions).length === 0) return { failure: 'abstain' }
    try {
      // A judge weighs what a call does, never the key it does it with.
      const known = this.knownSecrets()
      const result = await judge.evaluate({
        state: redactJson(state, known),
        questions: redactJson(questions, known),
        signal,
      })
      const evaluation: Evaluation<Out> = {
        answers: result.answers,
        latencyMs: result.latencyMs,
        usage: result.usage,
        providerId: result.providerId,
        modelId: result.modelId,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
      }
      const verdict = spec.policy(result.answers as AnswersFor<Qs>, input)
      if (verdict === ABSTAIN) evaluation.failure = 'abstain'
      else evaluation.judged = verdict
      return evaluation
    } catch (error) {
      if (!isJudgeError(error)) return { failure: 'error:unexpected' }
      return { failure: `error:${error.kind}`, usage: error.usage }
    }
  }

  private async record(record: LedgerRecord): Promise<void> {
    try {
      await this.ledger?.append(record)
    } catch {
      // A broken ledger must not change what the agent does.
    }
  }

  decide<In, const Qs extends Questions, Out extends JsonValue>(
    spec: DecisionSpec<In, Qs, Out>,
    input: In,
    options: DecideOptions = {},
  ): Promise<Decision<Out>> {
    return this.track(this.decideNow(spec, input, options))
  }

  /**
   * Records an outcome the host reached by deterministic rules under a
   * decision's mode, so the ledger measures it next to the judged ones. The
   * write is queued; its id is known at once, so later annotations follow it.
   * @returns the record id, or undefined when the decision is off.
   */
  recordRules(
    spec: { readonly id: string, readonly version: number },
    entry: {
      readonly outcome: JsonValue
      readonly state: JsonValue
      readonly origin?: JsonValue | undefined
      readonly savedChars?: number | undefined
      readonly applied?: boolean | undefined
    },
  ): string | undefined {
    const mode = this.modeOf(spec.id)
    if (mode === 'off') return undefined
    const id = randomUUID()
    void this.track(this.record({
      v: LEDGER_RECORD_VERSION,
      id,
      timestamp: new Date().toISOString(),
      origin: entry.origin,
      specId: spec.id,
      specVersion: spec.version,
      mode,
      providerId: 'rules',
      outcome: entry.outcome,
      source: 'rules',
      applied: entry.applied,
      savedChars: entry.savedChars,
      stateDigest: digest(entry.state),
      state: this.recordState ? entry.state : undefined,
    }))
    return id
  }

  private async decideNow<In, const Qs extends Questions, Out extends JsonValue>(
    spec: DecisionSpec<In, Qs, Out>,
    input: In,
    options: DecideOptions,
  ): Promise<Decision<Out>> {
    const mode = this.modeOf(spec.id)
    const fallback = spec.fallback(input)
    if (mode === 'off') return { specId: spec.id, mode, outcome: fallback, source: 'fallback', reason: 'off' }
    const judge = this.judgeFor(spec.id)
    if (judge === undefined) return { specId: spec.id, mode, outcome: fallback, source: 'fallback', reason: 'no-judge' }

    const state = spec.buildState(input)
    const evaluation = await this.evaluate(judge, spec, input, state, this.signalFor(options.signal))
    const judged = evaluation.judged
    const useJudged = mode === 'active' && judged !== undefined
    const outcome = useJudged ? judged : fallback
    const reason = useJudged ? undefined : (evaluation.failure ?? 'shadow')
    const source = useJudged ? 'judge' : 'fallback'

    const record: LedgerRecord = {
      v: LEDGER_RECORD_VERSION,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      origin: options.origin,
      applied: options.applied,
      specId: spec.id,
      specVersion: spec.version,
      mode,
      providerId: evaluation.providerId ?? judge.id,
      modelId: evaluation.modelId,
      outcome,
      source,
      reason,
      judged,
      answers: evaluation.answers,
      latencyMs: evaluation.latencyMs,
      usage: evaluation.usage,
      warnings: evaluation.warnings,
      stateDigest: digest(state),
      state: this.recordState ? (state as JsonValue) : undefined,
    }
    await this.record(record)

    return {
      specId: spec.id,
      mode,
      outcome,
      source,
      reason,
      judged,
      answers: evaluation.answers,
      latencyMs: evaluation.latencyMs,
      usage: evaluation.usage,
      warnings: evaluation.warnings,
      ledgerId: record.id,
    }
  }

  /**
   * The same decision over many inputs (batches of one tool output, candidate
   * results), written to the ledger as one record so a long output does not
   * bury everything else. Order is preserved.
   */
  decideMany<In, const Qs extends Questions, Out extends JsonValue>(
    spec: DecisionSpec<In, Qs, Out>,
    inputs: readonly In[],
    options: DecideOptions & { readonly concurrency?: number | undefined } = {},
  ): Promise<Decision<Out>[]> {
    return this.track(this.decideManyNow(spec, inputs, options))
  }

  private async decideManyNow<In, const Qs extends Questions, Out extends JsonValue>(
    spec: DecisionSpec<In, Qs, Out>,
    inputs: readonly In[],
    options: DecideOptions & { readonly concurrency?: number | undefined },
  ): Promise<Decision<Out>[]> {
    const mode = this.modeOf(spec.id)
    const judge = mode === 'off' ? undefined : this.judgeFor(spec.id)
    if (mode === 'off' || judge === undefined || inputs.length === 0) {
      const reason = mode === 'off' ? 'off' : 'no-judge'
      return inputs.map(input => ({ specId: spec.id, mode, outcome: spec.fallback(input), source: 'fallback' as const, reason }))
    }

    const signal = this.signalFor(options.signal)
    const startedAt = performance.now()
    const states = inputs.map(input => spec.buildState(input))
    const evaluations: Evaluation<Out>[] = new Array(inputs.length)
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < inputs.length) {
        const index = next++
        evaluations[index] = await this.evaluate(judge, spec, inputs[index] as In, states[index] as JudgeInput, signal)
      }
    }
    const workers = Math.max(1, Math.min(options.concurrency ?? 4, inputs.length))
    await Promise.all(Array.from({ length: workers }, worker))

    const ledgerId = randomUUID()
    const decisions = inputs.map((input, index): Decision<Out> => {
      const evaluation = evaluations[index] as Evaluation<Out>
      const judged = evaluation.judged
      const useJudged = mode === 'active' && judged !== undefined
      return {
        specId: spec.id,
        mode,
        outcome: useJudged ? judged : spec.fallback(input),
        source: useJudged ? 'judge' : 'fallback',
        reason: useJudged ? undefined : (evaluation.failure ?? 'shadow'),
        judged,
        answers: evaluation.answers,
        latencyMs: evaluation.latencyMs,
        usage: evaluation.usage,
        warnings: evaluation.warnings,
        ledgerId,
      }
    })

    const failures = evaluations.filter(evaluation => evaluation.failure?.startsWith('error:') === true).length
    await this.record({
      v: LEDGER_RECORD_VERSION,
      id: ledgerId,
      timestamp: new Date().toISOString(),
      origin: options.origin,
      applied: options.applied,
      specId: spec.id,
      specVersion: spec.version,
      mode,
      providerId: evaluations.find(evaluation => evaluation.providerId !== undefined)?.providerId ?? judge.id,
      modelId: evaluations.find(evaluation => evaluation.modelId !== undefined)?.modelId,
      outcome: decisions.map(decision => decision.outcome),
      source: decisions.some(decision => decision.source === 'judge') ? 'judge' : 'fallback',
      reason: mode === 'shadow' ? 'shadow' : failures === inputs.length ? 'error:all' : undefined,
      judged: evaluations.map(evaluation => evaluation.judged ?? null),
      latencyMs: Math.round(performance.now() - startedAt),
      usage: evaluations.reduce<JudgeUsage>((sum, evaluation) => addUsage(sum, evaluation.usage), {}),
      batch: {
        size: inputs.length,
        failures,
        // Small batches keep every verdict for inspection; large ones would bloat the ledger.
        answers: inputs.length <= MAX_BATCH_ANSWERS ? evaluations.map(evaluation => evaluation.answers ?? null) : undefined,
      },
      stateDigest: digest(states),
      state: this.recordState ? (states as JsonValue) : undefined,
    })
    return decisions
  }
}
