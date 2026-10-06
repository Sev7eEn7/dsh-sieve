/**
 * One judge provider behind a timeout, with request fan-out and answer
 * validation. Throws `JudgeError`; the decision engine turns those into
 * fallbacks.
 *
 * The deadline and the caller's signal bound the call whether or not the
 * provider honors them: an answer that arrives after either fired is not
 * accepted. Every failure carries what its requests are known to have cost.
 *
 * Adapted from mu `packages/kyrn-judge/src/judge.ts` (MIT, see
 * THIRD_PARTY_NOTICES.md) without the cascade: sieve has one judge per
 * decision, chosen by the host.
 * @module
 */

import { JudgeError, isJudgeError } from './errors.ts'
import type { JudgeErrorKind } from './errors.ts'
import type { Inflight } from './inflight.ts'
import { addUsage } from './types.ts'
import type { Answer, AnswersFor, JudgeInput, JudgeProvider, JudgeUsage, JudgeWarning, ProviderResponse, Question, Questions } from './types.ts'

const DEFAULT_TIMEOUT_MS = 4000
/** Per-request question limit; larger sets are fanned out over the same state. */
const DEFAULT_MAX_QUESTIONS_PER_REQUEST = 32

export interface JudgeCall<Qs extends Questions> {
  readonly state: JudgeInput
  readonly questions: Qs
  readonly signal?: AbortSignal | undefined
}

export interface JudgeResult<Qs extends Questions> {
  readonly answers: AnswersFor<Qs>
  readonly usage: JudgeUsage
  readonly latencyMs: number
  readonly requests: number
  readonly providerId: string
  /** The model the provider says it used, when it reports one. */
  readonly modelId?: string | undefined
  /** What the provider cut or ignored. Empty when it reported nothing. */
  readonly warnings: readonly JudgeWarning[]
}

/** Anything that answers typed questions about one state. */
export interface JudgeLike {
  readonly id: string
  evaluate<const Qs extends Questions>(request: JudgeCall<Qs>): Promise<JudgeResult<Qs>>
}

export interface JudgeOptions {
  readonly provider: JudgeProvider
  readonly timeoutMs?: number | undefined
  readonly maxQuestionsPerRequest?: number | undefined
  /** Tracks every provider call until it settles, including calls the judge stopped waiting for. */
  readonly inflight?: Inflight | undefined
}

/** Refuse malformed question sets before any I/O. */
export function validateQuestions(questions: Questions): void {
  const ids = Object.keys(questions)
  if (ids.length === 0) throw new TypeError('A judge request needs at least one question')
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'choice' && Object.keys(question.criteria).length === 0) {
      throw new TypeError(`Choice question "${id}" has no options`)
    }
    if (question.type === 'score' && question.criteria.length < 2) {
      throw new TypeError(`Score question "${id}" needs at least two levels`)
    }
  }
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** A reported distribution may be partial, but every number in it must be a probability. */
function distributionProblem(probabilities: unknown): string | undefined {
  if (probabilities === undefined) return undefined
  if (typeof probabilities !== 'object' || probabilities === null || Array.isArray(probabilities)) return 'has an invalid distribution'
  const invalid = Object.entries(probabilities).find(([, value]) => !isProbability(value))
  return invalid === undefined ? undefined : `has an invalid probability for "${invalid[0]}"`
}

function answerProblem(question: Question, answer: Answer | undefined): string | undefined {
  if (answer === undefined) return 'is missing'
  if (answer.type !== question.type) return `has type "${answer.type}", expected "${question.type}"`
  // Policies read confidence when no distribution is reported, so it is validated like one.
  if (answer.confidence !== undefined && !isProbability(answer.confidence)) return 'has an invalid confidence'
  if (answer.type === 'boolean') return isProbability(answer.probability) ? undefined : 'has an invalid probability'
  if (answer.type === 'choice' && question.type === 'choice') {
    if (!Object.hasOwn(question.criteria, answer.choice)) return `picked unknown option "${answer.choice}"`
    return distributionProblem(answer.probabilities)
  }
  if (answer.type === 'score' && question.type === 'score') {
    const max = question.criteria.length - 1
    const inRange = Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= max
    if (!inRange) return `has score ${answer.score} outside [0, ${max}]`
    return distributionProblem(answer.probabilities)
  }
  return undefined
}

type Settled = PromiseSettledResult<ProviderResponse> | undefined

/** Each call's outcome once all have settled, or what has settled by the time `signal` aborts. */
function settleUntilAborted(calls: readonly Promise<ProviderResponse>[], signal: AbortSignal): Promise<readonly Settled[]> {
  const outcomes: Settled[] = calls.map(() => undefined)
  return new Promise((resolve) => {
    let remaining = calls.length
    const finish = (): void => {
      signal.removeEventListener('abort', finish)
      resolve([...outcomes])
    }
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
    calls.forEach((call, index) => {
      call.then(
        (value) => {
          outcomes[index] = { status: 'fulfilled', value }
        },
        (reason: unknown) => {
          outcomes[index] = { status: 'rejected', reason }
        },
      ).finally(() => {
        if (--remaining === 0) finish()
      })
    })
  })
}

function usageOf(outcome: Settled): JudgeUsage | undefined {
  if (outcome === undefined) return undefined
  if (outcome.status === 'fulfilled') return outcome.value.usage
  return isJudgeError(outcome.reason) ? outcome.reason.usage : undefined
}

/** The sum of what is known; undefined when no request reported anything, never a made-up zero. */
function knownUsage(outcomes: readonly Settled[]): JudgeUsage | undefined {
  const reported = outcomes.map(usageOf).filter((usage): usage is JudgeUsage => usage !== undefined)
  return reported.length === 0 ? undefined : reported.reduce<JudgeUsage>((sum, usage) => addUsage(sum, usage), {})
}

function failure(kind: JudgeErrorKind, message: string, usage: JudgeUsage | undefined, cause: unknown): JudgeError {
  return new JudgeError(kind, message, { cause, usage })
}

/** A provider's own failure, carrying the usage of the whole call rather than of its one request. */
function providerFailure(error: unknown, usage: JudgeUsage | undefined): JudgeError {
  if (!isJudgeError(error)) return failure('unreachable', 'Judge provider failed', usage, error)
  return new JudgeError(error.kind, error.message, { status: error.status, cause: error.cause, usage })
}

/** Starts a provider call; a synchronous throw becomes a rejection. */
function invoke(start: () => Promise<ProviderResponse>): Promise<ProviderResponse> {
  try {
    return start()
  } catch (error) {
    return Promise.reject(error)
  }
}

export class Judge implements JudgeLike {
  readonly provider: JudgeProvider
  private readonly timeoutMs: number
  private readonly maxQuestionsPerRequest: number
  private readonly inflight: Inflight | undefined

  get id(): string {
    return this.provider.id
  }

  constructor(options: JudgeOptions) {
    this.provider = options.provider
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxQuestionsPerRequest = options.maxQuestionsPerRequest ?? DEFAULT_MAX_QUESTIONS_PER_REQUEST
    this.inflight = options.inflight
  }

  async evaluate<const Qs extends Questions>(request: JudgeCall<Qs>): Promise<JudgeResult<Qs>> {
    validateQuestions(request.questions)
    const ids = Object.keys(request.questions)
    const chunks: Questions[] = []
    for (let start = 0; start < ids.length; start += this.maxQuestionsPerRequest) {
      const chunkIds = ids.slice(start, start + this.maxQuestionsPerRequest)
      chunks.push(Object.fromEntries(chunkIds.map(id => [id, request.questions[id] as Question])))
    }

    if (request.signal?.aborted) throw new JudgeError('aborted', 'Judge call was aborted', { cause: request.signal.reason })
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal])
    const startedAt = performance.now()

    // Questions are answered in isolation, so chunks can run concurrently over the same state.
    const calls = chunks.map((questions) => {
      const call = invoke(() => this.provider.evaluate({ state: request.state, questions, signal }))
      return this.inflight === undefined ? call : this.inflight.track(call)
    })
    const outcomes = await settleUntilAborted(calls, signal)
    const usage = knownUsage(outcomes)

    // Checked after the answers arrive too: a provider that ignores the signal must not decide late.
    if (request.signal?.aborted) throw failure('aborted', 'Judge call was aborted', usage, request.signal.reason)
    if (timeout.aborted) throw failure('timeout', `Judge call exceeded ${this.timeoutMs} ms`, usage, timeout.reason)
    const rejected = outcomes.find(outcome => outcome?.status === 'rejected')
    if (rejected?.status === 'rejected') throw providerFailure(rejected.reason, usage)

    const responses = outcomes.map(outcome => (outcome as PromiseFulfilledResult<ProviderResponse>).value)
    const answers: Record<string, Answer> = {}
    const warnings: JudgeWarning[] = []
    for (const response of responses) {
      Object.assign(answers, response.answers)
      if (response.warnings !== undefined) warnings.push(...response.warnings)
    }
    for (const id of ids) {
      const problem = answerProblem(request.questions[id] as Question, answers[id])
      if (problem !== undefined) throw failure('invalid_response', `Answer for "${id}" ${problem}`, usage, undefined)
    }

    return {
      answers: answers as AnswersFor<Qs>,
      usage: usage ?? {},
      latencyMs: Math.round(performance.now() - startedAt),
      requests: chunks.length,
      providerId: this.provider.id,
      modelId: responses.find(response => response.modelId !== undefined)?.modelId,
      warnings,
    }
  }
}
