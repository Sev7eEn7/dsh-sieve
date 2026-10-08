/**
 * Jev over System One: TypeSafe's own endpoint, or another service that serves
 * the same protocol, such as OpenRouter. Uses `fetch` directly; error messages
 * name the service, never the key or the submitted state.
 *
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * @module
 */

import { JudgeError } from '../errors.ts'
import type { JudgeErrorKind } from '../errors.ts'
import type { Answer, JudgeProvider, JudgeRequest, JudgeUsage, ProviderResponse, Question } from '../types.ts'
import { MAX_ERROR_MESSAGE_LENGTH, messageFromErrorBody, readWarnings } from './http.ts'

export const SYSTEM_ONE_BASE_URL = 'https://api.typesafe.ai/v1/systemone'
export const SYSTEM_ONE_DEFAULT_MODEL = 'jev-latest'
/** OpenRouter names Jev its own way. */
export const OPENROUTER_DEFAULT_MODEL = '~typesafe/jev-latest'

export interface SystemOneJudgeProviderOptions {
  /** Nonempty; sieve's configuration refuses a system-one judge without one. */
  readonly apiKey: string
  readonly model?: string | undefined
  /** Any service that speaks System One; empty is TypeSafe's own. */
  readonly baseUrl?: string | undefined
  readonly fetch?: typeof fetch | undefined
}

interface SystemOneBody {
  model?: unknown
  answers?: Record<string, Record<string, unknown>>
  usage?: { input_tokens?: unknown, output_tokens?: unknown }
  warnings?: unknown
}

function errorKindForStatus(status: number, message: string): JudgeErrorKind {
  if (status === 401) return 'auth'
  if (status === 402) return 'payment_required'
  if (status === 403) return /credit|payment|billing|quota/i.test(message) ? 'payment_required' : 'auth'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server'
  return 'bad_request'
}

/** System One calls a yes/no question `noul`; everything else has the kernel's own shape. */
function toWire(question: Question): Record<string, unknown> {
  if (question.type !== 'boolean') return { ...question }
  return question.criteria === undefined
    ? { type: 'noul', instructions: question.instructions }
    : { type: 'noul', instructions: question.instructions, criteria: question.criteria }
}

const numberOr = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const isProbability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** Not reported: absent. Invalid: present but not a usable value, which makes the whole answer unusable. */
const INVALID = Symbol('invalid')

/** An optional probability field: absent or null is unreported, anything else must be in [0, 1]. */
function optionalProbability(value: unknown): number | undefined | typeof INVALID {
  if (value === undefined || value === null) return undefined
  return isProbability(value) ? value : INVALID
}

/**
 * A choice distribution. It may be partial (only the picked option), but an
 * entry that is not a probability invalidates it: dropping just that entry
 * would read as "no number reported" and lift the policy's threshold.
 */
function probabilitiesOf(value: unknown): Record<string, number> | undefined | typeof INVALID {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return INVALID
  const entries = Object.entries(value)
  if (!entries.every(([, probability]) => isProbability(probability))) return INVALID
  return entries.length > 0 ? Object.fromEntries(entries) as Record<string, number> : undefined
}

function usageOf(body: SystemOneBody | undefined): JudgeUsage | undefined {
  const inputTokens = numberOr(body?.usage?.input_tokens)
  const outputTokens = numberOr(body?.usage?.output_tokens)
  return inputTokens === undefined && outputTokens === undefined ? undefined : { inputTokens, outputTokens }
}

function fromWire(question: Question, raw: Record<string, unknown> | undefined): Answer | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const confidence = optionalProbability(raw['confidence'])
  if (confidence === INVALID) return undefined
  if (question.type === 'boolean') {
    const probability = numberOr(raw['noul'])
    return probability === undefined ? undefined : { type: 'boolean', probability, confidence }
  }
  if (question.type === 'score') {
    const score = numberOr(raw['score'])
    return score === undefined ? undefined : { type: 'score', score, confidence }
  }
  const choice = raw['choice']
  if (typeof choice !== 'string' || !Object.hasOwn(question.criteria, choice)) return undefined
  const probabilities = probabilitiesOf(raw['probabilities'])
  if (probabilities === INVALID) return undefined
  return { type: 'choice', choice, probabilities, confidence }
}

export class SystemOneJudgeProvider implements JudgeProvider {
  readonly id: string
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  /** "TypeSafe" at TypeSafe's own address, otherwise the host the requests go to, e.g. "openrouter.ai". */
  private readonly service: string
  private readonly fetchImpl: typeof fetch

  constructor(options: SystemOneJudgeProviderOptions) {
    this.apiKey = options.apiKey
    this.baseUrl = (options.baseUrl === undefined || options.baseUrl === '' ? SYSTEM_ONE_BASE_URL : options.baseUrl).replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? fetch
    const host = URL.canParse(this.baseUrl) ? new URL(this.baseUrl).host : this.baseUrl
    this.service = host === new URL(SYSTEM_ONE_BASE_URL).host ? 'TypeSafe' : host
    this.model = options.model !== undefined && options.model !== ''
      ? options.model
      : host === 'openrouter.ai' ? OPENROUTER_DEFAULT_MODEL : SYSTEM_ONE_DEFAULT_MODEL
    this.id = `${this.service === 'TypeSafe' ? 'typesafe' : host}:${this.model}`
  }

  async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
    const questions = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, toWire(question)]))
    let response: Response
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, state: request.state, questions }),
        ...request.signal === undefined ? {} : { signal: request.signal },
      })
    } catch (error) {
      // The kernel classifies aborts: it knows whether its timeout or the caller fired.
      if (request.signal?.aborted) throw error
      throw new JudgeError('unreachable', `Could not reach ${this.service}`, { cause: error })
    }

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined)
      const message = messageFromErrorBody(body).slice(0, MAX_ERROR_MESSAGE_LENGTH)
      throw new JudgeError(
        errorKindForStatus(response.status, message),
        message === '' ? `${this.service} responded with HTTP ${response.status}` : message,
        { status: response.status },
      )
    }

    const parsed: unknown = await response.json().catch(() => undefined)
    const body = typeof parsed === 'object' && parsed !== null ? parsed as SystemOneBody : undefined
    // Read before the answers: a reply that cannot be used was still paid for.
    const usage = usageOf(body)
    if (body === undefined || typeof body.answers !== 'object' || body.answers === null) {
      throw new JudgeError('invalid_response', `${this.service} response has no answers`, { status: response.status, usage })
    }
    const answers: Record<string, Answer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = fromWire(question, body.answers[id])
      if (answer === undefined) {
        throw new JudgeError('invalid_response', `${this.service} gave no usable answer for "${id}"`, { status: response.status, usage })
      }
      answers[id] = answer
    }
    return {
      answers,
      usage,
      modelId: typeof body.model === 'string' ? body.model : this.model,
      warnings: readWarnings(body.warnings),
    }
  }
}
