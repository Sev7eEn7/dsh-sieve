/**
 * Wire-level contract of a typed judge: questions about one shared state,
 * answered with probabilities. The shapes match System One, so a request can
 * reach Jev without translation.
 *
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * Cascade-only fields are dropped; usage carries the
 * same disjoint counters as DSH `TokenUsage`.
 * @module
 */

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** Shared state or structured instructions. */
export type JudgeInput = string | { readonly [key: string]: JsonValue } | readonly JsonValue[]

/** Yes/no judgment. */
export interface BooleanQuestion {
  readonly type: 'boolean'
  readonly instructions: JudgeInput
  readonly criteria?: { readonly true?: JudgeInput | null, readonly false?: JudgeInput | null }
}

/** Pick one option from a closed set. */
export interface ChoiceQuestion {
  readonly type: 'choice'
  readonly instructions: JudgeInput
  /** Option name to description. Null means no description. Must not be empty. */
  readonly criteria: Readonly<Record<string, JudgeInput | null>>
}

/** Place the state on an ordered rubric. */
export interface ScoreQuestion {
  readonly type: 'score'
  readonly instructions: JudgeInput
  /** At least two ordered levels, indexed from zero. */
  readonly criteria: readonly (JudgeInput | null)[]
}

export type Question = BooleanQuestion | ChoiceQuestion | ScoreQuestion
export type Questions = Readonly<Record<string, Question>>

/** Optional self-assessment some providers attach to an answer. */
export interface AnswerSignals {
  /** Provider-reported confidence in [0, 1]. */
  readonly confidence?: number | undefined
}

export interface BooleanAnswer extends AnswerSignals {
  readonly type: 'boolean'
  /** Model-estimated P(true) in [0, 1]. Not confidence in either outcome. */
  readonly probability: number
}

export interface ChoiceAnswer<Option extends string = string> extends AnswerSignals {
  readonly type: 'choice'
  readonly choice: Option
  /** Distribution over the options, when the provider supplies one; may cover only the picked option. */
  readonly probabilities?: Readonly<Partial<Record<Option, number>>> | undefined
}

export interface ScoreAnswer extends AnswerSignals {
  readonly type: 'score'
  /** Fractional position in [0, levels - 1]. */
  readonly score: number
  /** Distribution keyed by zero-based level index as a string. */
  readonly probabilities?: Readonly<Record<string, number>> | undefined
}

export type Answer = BooleanAnswer | ChoiceAnswer | ScoreAnswer

export type AnswerFor<Q extends Question> = Q extends { readonly type: 'choice', readonly criteria: infer Criteria }
  ? ChoiceAnswer<Extract<keyof Criteria, string>>
  : Q extends { readonly type: 'score' }
    ? ScoreAnswer
    : BooleanAnswer

export type AnswersFor<Qs extends Questions> = { readonly [Id in keyof Qs]: AnswerFor<Qs[Id]> }

/**
 * Token accounting for judge calls. Counters are disjoint, as in DSH
 * `TokenUsage`: `inputTokens` is uncached input, cached input is reported in
 * `cacheReadTokens` / `cacheWriteTokens`. A provider that reports no counter
 * leaves it undefined rather than zero.
 */
export interface JudgeUsage {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  cacheReadTokens?: number | undefined
  cacheWriteTokens?: number | undefined
  reasoningTokens?: number | undefined
}

/** Something the provider did that the caller did not ask for, such as truncating the state. */
export interface JudgeWarning {
  readonly type: string
  readonly message?: string | undefined
  readonly questionId?: string | undefined
}

export interface JudgeRequest {
  readonly state: JudgeInput
  readonly questions: Questions
  readonly signal?: AbortSignal | undefined
}

export interface ProviderResponse {
  readonly answers: Readonly<Record<string, Answer>>
  readonly usage?: JudgeUsage | undefined
  readonly modelId?: string | undefined
  readonly warnings?: readonly JudgeWarning[] | undefined
}

/**
 * A backend that answers typed questions about one shared state.
 *
 * Implementations throw `JudgeError` and must not retry: the kernel owns
 * timeouts and the fail-open policy.
 */
export interface JudgeProvider {
  readonly id: string
  evaluate(request: JudgeRequest): Promise<ProviderResponse>
}

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const

/** Sum of two usages; a counter neither side reported stays undefined. */
export function addUsage(left: JudgeUsage | undefined, right: JudgeUsage | undefined): JudgeUsage {
  const sum: JudgeUsage = {}
  for (const key of USAGE_KEYS) {
    const a = left?.[key]
    const b = right?.[key]
    if (a !== undefined || b !== undefined) sum[key] = (a ?? 0) + (b ?? 0)
  }
  return sum
}
