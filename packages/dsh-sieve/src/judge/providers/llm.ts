/**
 * Any generative model as a judge: the questions go out as JSON, the reply is
 * parsed back into typed answers. Its probabilities are verbalized rather than
 * read off logits, so it is less calibrated than a System One model, but it
 * needs no account beyond the model route the user already has.
 *
 * The prompt and the reply parsing are ported from mu
 * `packages/kyrn-judge/src/providers/llm.ts` (MIT, see THIRD_PARTY_NOTICES.md).
 * The host supplies the model call (`LlmCompletion`), so this module stays free
 * of any model SDK; sieve binds it to DSH `ctx.llm` in `src/runtime/`.
 * @module
 */

import { JudgeError } from '../errors.ts'
import type { Answer, JudgeProvider, JudgeRequest, JudgeUsage, ProviderResponse, Question } from '../types.ts'

export interface LlmCompletionRequest {
  readonly system: string
  readonly user: string
  readonly signal?: AbortSignal | undefined
}

export interface LlmCompletionResult {
  readonly text: string
  readonly usage?: JudgeUsage | undefined
  /** The model that answered, e.g. "deepseek/deepseek-v4-flash". */
  readonly modelId?: string | undefined
}

/** The host's model call. Rejects on infrastructure failure; aborts follow `signal`. */
export type LlmCompletion = (request: LlmCompletionRequest) => Promise<LlmCompletionResult>

export interface LlmJudgeProviderOptions {
  /** Shown in the ledger as the provider id, e.g. "llm". */
  readonly id: string
  readonly complete: LlmCompletion
}

export const LLM_JUDGE_SYSTEM_PROMPT = `You are a judgment function inside a coding agent harness. You read STATE and answer typed QUESTIONS about it. You never explain.

Answer formats, by question type:
- boolean: {"p": <number>}  probability in [0,1] that the statement is true. Use the whole range; 0.5 means the state does not say.
- choice:  {"choice": "<one option name>", "p": <number>}  p is the probability that this option is the right one.
- score:   {"score": <number>}  position on the rubric from 0 (first level) to N-1 (last level). Fractions are allowed.

Judge only from STATE. Answer every question id. Reply with exactly one JSON object and nothing else:
{"answers": {"<question id>": {...}}}`

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function renderQuestion(question: Question): Record<string, unknown> {
  if (question.type === 'choice') {
    return { type: 'choice', instructions: question.instructions, options: question.criteria }
  }
  if (question.type === 'score') {
    return { type: 'score', instructions: question.instructions, levels: question.criteria }
  }
  return question.criteria === undefined
    ? { type: 'boolean', instructions: question.instructions }
    : { type: 'boolean', instructions: question.instructions, meaning: question.criteria }
}

function toAnswer(question: Question, raw: unknown): Answer | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (question.type === 'boolean') {
    return typeof record['p'] === 'number' ? { type: 'boolean', probability: clamp(record['p'], 0, 1) } : undefined
  }
  if (question.type === 'score') {
    const score = record['score']
    if (typeof score !== 'number') return undefined
    return { type: 'score', score: clamp(score, 0, question.criteria.length - 1) }
  }
  const options = Object.keys(question.criteria)
  const choice = record['choice']
  if (typeof choice !== 'string' || !options.includes(choice)) return undefined
  const picked = typeof record['p'] === 'number' ? clamp(record['p'], 0, 1) : 1
  const rest = options.length > 1 ? (1 - picked) / (options.length - 1) : 0
  const probabilities = Object.fromEntries(options.map(option => [option, option === choice ? picked : rest]))
  return { type: 'choice', choice, probabilities }
}

/** The outermost JSON object in a reply that may be wrapped in prose or a code fence. */
function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

export class LlmJudgeProvider implements JudgeProvider {
  readonly id: string
  private readonly complete: LlmCompletion

  constructor(options: LlmJudgeProviderOptions) {
    this.id = options.id
    this.complete = options.complete
  }

  async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
    const questions = Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [id, renderQuestion(question)]),
    )
    const state = typeof request.state === 'string' ? request.state : JSON.stringify(request.state, null, 1)

    let result: LlmCompletionResult
    try {
      result = await this.complete({
        system: LLM_JUDGE_SYSTEM_PROMPT,
        user: `STATE:\n${state}\n\nQUESTIONS:\n${JSON.stringify(questions, null, 1)}`,
        signal: request.signal,
      })
    } catch (error) {
      // The kernel classifies aborts: it knows whether its timeout or the caller fired.
      if (error instanceof JudgeError) throw error
      if (request.signal?.aborted) throw error
      throw new JudgeError('unreachable', 'The judge model call failed', { cause: error })
    }

    const parsed = extractJson(result.text)
    const rawAnswers = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['answers'] : undefined
    if (typeof rawAnswers !== 'object' || rawAnswers === null) {
      throw new JudgeError('invalid_response', 'The judge model did not reply with an answers object', { usage: result.usage })
    }
    const answers: Record<string, Answer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = toAnswer(question, (rawAnswers as Record<string, unknown>)[id])
      if (answer === undefined) {
        throw new JudgeError('invalid_response', `The judge model gave no usable answer for "${id}"`, { usage: result.usage })
      }
      answers[id] = answer
    }
    return { answers, usage: result.usage, modelId: result.modelId ?? this.id }
  }
}
