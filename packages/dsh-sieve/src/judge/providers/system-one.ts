/**
 * Jev over System One: TypeSafe's own endpoint, or another service that serves
 * the same protocol, such as OpenRouter. Uses `fetch` directly; error messages
 * name the service and the key's variable, never the key or the submitted state.
 *
 * Adapted from mu `packages/kyrn-judge/src/providers/typesafe.ts` (MIT, see
 * THIRD_PARTY_NOTICES.md), without the CLM and key-optional variants.
 * @module
 */

import { JudgeError } from '../errors.ts'
import type { JudgeErrorKind } from '../errors.ts'
import type { Answer, JudgeProvider, JudgeRequest, ProviderResponse, Question } from '../types.ts'
import { MAX_ERROR_MESSAGE_LENGTH, messageFromErrorBody, readWarnings } from './http.ts'

export const SYSTEM_ONE_BASE_URL = 'https://api.typesafe.ai/v1/systemone'
export const SYSTEM_ONE_DEFAULT_MODEL = 'jev-latest'
/** OpenRouter names Jev its own way. */
export const OPENROUTER_DEFAULT_MODEL = '~typesafe/jev-latest'

/** A key, or a resolver called per request so the host owns credential storage. */
export type ApiKeyResolver = () => string | undefined | Promise<string | undefined>

export interface SystemOneJudgeProviderOptions {
  readonly apiKey: string | ApiKeyResolver
  /** Where the key comes from, named when it is missing, e.g. "judge.apiKey". */
  readonly keyName?: string | undefined
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

function probabilitiesOf(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function fromWire(question: Question, raw: Record<string, unknown> | undefined): Answer | undefined {
  if (raw === undefined) return undefined
  const confidence = numberOr(raw['confidence'])
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
  return { type: 'choice', choice, probabilities: probabilitiesOf(raw['probabilities']), confidence }
}

export class SystemOneJudgeProvider implements JudgeProvider {
  readonly id: string
  private readonly apiKey: string | ApiKeyResolver
  private readonly keyName: string
  private readonly model: string
  private readonly baseUrl: string
  /** "TypeSafe" at TypeSafe's own address, otherwise the host the requests go to, e.g. "openrouter.ai". */
  private readonly service: string
  private readonly fetchImpl: typeof fetch

  constructor(options: SystemOneJudgeProviderOptions) {
    this.apiKey = options.apiKey
    this.keyName = options.keyName ?? 'judge.apiKey'
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
    const apiKey = typeof this.apiKey === 'string' ? this.apiKey : await this.apiKey()
    if (apiKey === undefined || apiKey === '') {
      throw new JudgeError('auth', `No API key is configured for Jev at ${this.service} (${this.keyName})`)
    }

    const questions = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, toWire(question)]))
    let response: Response
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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

    const body = (await response.json().catch(() => undefined)) as SystemOneBody | undefined
    if (body === undefined || typeof body.answers !== 'object' || body.answers === null) {
      throw new JudgeError('invalid_response', `${this.service} response has no answers`, { status: response.status })
    }
    const answers: Record<string, Answer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = fromWire(question, body.answers[id])
      if (answer === undefined) throw new JudgeError('invalid_response', `${this.service} gave no usable answer for "${id}"`)
      answers[id] = answer
    }
    return {
      answers,
      usage: { inputTokens: numberOr(body.usage?.input_tokens), outputTokens: numberOr(body.usage?.output_tokens) },
      modelId: typeof body.model === 'string' ? body.model : this.model,
      warnings: readWarnings(body.warnings),
    }
  }
}
