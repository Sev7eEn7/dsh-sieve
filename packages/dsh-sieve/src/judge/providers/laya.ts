/**
 * Laya, the open-weight typed decision model, served on this machine by the
 * local sidecar (macOS on Apple Silicon, Core ML). Request and answers have
 * the kernel's own shapes; nothing leaves the machine and there is no key.
 *
 * The sidecar reads a bounded window (1024 tokens for the default checkpoint,
 * shared by the question, its options and the state) and keeps the head of the
 * state; what it cuts comes back as warnings.
 *
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * @module
 */

import { JudgeError } from '../errors.ts'
import type { Answer, JudgeProvider, JudgeRequest, JudgeUsage, ProviderResponse } from '../types.ts'
import { MAX_ERROR_MESSAGE_LENGTH, messageFromErrorBody, readWarnings } from './http.ts'

export const LAYA_BASE_URL = 'http://127.0.0.1:47823'

export interface LayaJudgeProviderOptions {
  /** The sidecar; empty is its default address. */
  readonly baseUrl?: string | undefined
  readonly fetch?: typeof fetch | undefined
}

interface LayaBody {
  answers?: Record<string, unknown>
  usage?: { inputTokens?: unknown, outputTokens?: unknown }
  warnings?: unknown
  providerMetadata?: { laya?: { model?: unknown, answers?: Record<string, { confidence?: unknown } | undefined> } }
}

const numberOr = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

function usageOf(body: LayaBody | undefined): JudgeUsage | undefined {
  const inputTokens = numberOr(body?.usage?.inputTokens)
  const outputTokens = numberOr(body?.usage?.outputTokens)
  return inputTokens === undefined && outputTokens === undefined ? undefined : { inputTokens, outputTokens }
}

export class LayaJudgeProvider implements JudgeProvider {
  readonly id = 'laya'
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: LayaJudgeProviderOptions = {}) {
    this.baseUrl = (options.baseUrl === undefined || options.baseUrl === '' ? LAYA_BASE_URL : options.baseUrl).replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? fetch
  }

  async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: request.state, questions: request.questions }),
        ...request.signal === undefined ? {} : { signal: request.signal },
      })
    } catch (error) {
      // The kernel classifies aborts: it knows whether its timeout or the caller fired.
      if (request.signal?.aborted) throw error
      throw new JudgeError('unreachable', `Laya is not reachable at ${this.baseUrl}; start the local Laya server`, { cause: error })
    }

    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined)
      const message = messageFromErrorBody(body).slice(0, MAX_ERROR_MESSAGE_LENGTH)
      throw new JudgeError(
        response.status >= 500 ? 'server' : 'bad_request',
        message === '' ? `Laya responded with HTTP ${response.status}` : message,
        { status: response.status },
      )
    }

    const parsed: unknown = await response.json().catch(() => undefined)
    const body = typeof parsed === 'object' && parsed !== null ? parsed as LayaBody : undefined
    const usage = usageOf(body)
    if (body === undefined || typeof body.answers !== 'object' || body.answers === null) {
      throw new JudgeError('invalid_response', 'Laya response has no answers', { status: response.status, usage })
    }
    const metadata = body.providerMetadata?.laya
    const answers: Record<string, Answer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      const raw = body.answers[id]
      // The judge wrapper validates the numbers; here only the shape must match the question.
      if (typeof raw !== 'object' || raw === null || (raw as { type?: unknown }).type !== question.type) {
        throw new JudgeError('invalid_response', `Laya gave no usable answer for "${id}"`, { status: response.status, usage })
      }
      // Laya's self-assessment is optional; one out of range is dropped rather than failing the answer.
      const reported = metadata?.answers?.[id]?.confidence
      const confidence = typeof reported === 'number' && reported >= 0 && reported <= 1 ? reported : undefined
      answers[id] = { ...raw as Answer, confidence }
    }
    return {
      answers,
      usage,
      modelId: typeof metadata?.model === 'string' ? metadata.model : 'laya',
      warnings: readWarnings(body.warnings),
    }
  }
}
