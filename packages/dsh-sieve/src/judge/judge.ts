/**
 * One judge provider behind a timeout, with request fan-out and answer
 * validation. Throws `JudgeError`; the decision engine turns those into
 * fallbacks.
 *
 * Adapted from mu `packages/kyrn-judge/src/judge.ts` (MIT, see
 * THIRD_PARTY_NOTICES.md) without the cascade: sieve has one judge per
 * decision, chosen by the host.
 * @module
 */

import { JudgeError } from './errors.ts'
import { addUsage } from './types.ts'
import type { Answer, AnswersFor, JudgeInput, JudgeProvider, JudgeUsage, JudgeWarning, Question, Questions } from './types.ts'

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

function answerProblem(question: Question, answer: Answer | undefined): string | undefined {
  if (answer === undefined) return 'is missing'
  if (answer.type !== question.type) return `has type "${answer.type}", expected "${question.type}"`
  if (answer.type === 'boolean') return isProbability(answer.probability) ? undefined : 'has an invalid probability'
  if (answer.type === 'choice' && question.type === 'choice') {
    return Object.hasOwn(question.criteria, answer.choice) ? undefined : `picked unknown option "${answer.choice}"`
  }
  if (answer.type === 'score' && question.type === 'score') {
    const max = question.criteria.length - 1
    const inRange = Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= max
    return inRange ? undefined : `has score ${answer.score} outside [0, ${max}]`
  }
  return undefined
}

export class Judge implements JudgeLike {
  readonly provider: JudgeProvider
  private readonly timeoutMs: number
  private readonly maxQuestionsPerRequest: number

  get id(): string {
    return this.provider.id
  }

  constructor(options: JudgeOptions) {
    this.provider = options.provider
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxQuestionsPerRequest = options.maxQuestionsPerRequest ?? DEFAULT_MAX_QUESTIONS_PER_REQUEST
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

    let responses: Awaited<ReturnType<JudgeProvider['evaluate']>>[]
    try {
      // Questions are answered in isolation, so chunks can run concurrently over the same state.
      responses = await Promise.all(chunks.map(questions => this.provider.evaluate({ state: request.state, questions, signal })))
    } catch (error) {
      if (request.signal?.aborted) throw new JudgeError('aborted', 'Judge call was aborted', { cause: error })
      if (timeout.aborted) throw new JudgeError('timeout', `Judge call exceeded ${this.timeoutMs} ms`, { cause: error })
      if (error instanceof JudgeError) throw error
      throw new JudgeError('unreachable', 'Judge provider failed', { cause: error })
    }

    const answers: Record<string, Answer> = {}
    let usage: JudgeUsage = {}
    const warnings: JudgeWarning[] = []
    for (const response of responses) {
      Object.assign(answers, response.answers)
      if (response.warnings !== undefined) warnings.push(...response.warnings)
      usage = addUsage(usage, response.usage)
    }
    for (const id of ids) {
      const problem = answerProblem(request.questions[id] as Question, answers[id])
      if (problem !== undefined) throw new JudgeError('invalid_response', `Answer for "${id}" ${problem}`)
    }

    return {
      answers: answers as AnswersFor<Qs>,
      usage,
      latencyMs: Math.round(performance.now() - startedAt),
      requests: chunks.length,
      providerId: this.provider.id,
      modelId: responses.find(response => response.modelId !== undefined)?.modelId,
      warnings,
    }
  }
}
