/**
 * Decision specs: what a judge is asked at one decision point, and how its
 * answers become an outcome the host acts on.
 *
 * The spec shape is ported from mu `packages/kyrn-judge/src/decision.ts` (MIT,
 * see THIRD_PARTY_NOTICES.md) so mu's question wordings, policies and versions
 * carry over unchanged; the cascade-only `capabilities` field is dropped.
 * @module
 */

import { validateQuestions } from './judge.ts'
import { hasEscapeOption } from './policy.ts'
import type { AnswersFor, JsonValue, JudgeInput, Questions } from './types.ts'

export const ABSTAIN: unique symbol = Symbol('sieve.judge.abstain')
export type Abstain = typeof ABSTAIN

/**
 * - `off`: the judge is not called; the fallback is returned.
 * - `shadow`: the judge is called and recorded, but the fallback is returned.
 *   New decision points start here until their verdicts have been compared
 *   with outcomes.
 * - `active`: the judged outcome is returned unless the policy abstains or the call fails.
 */
export type DecisionMode = 'off' | 'shadow' | 'active'

export const DECISION_MODES: readonly DecisionMode[] = ['off', 'shadow', 'active']

/**
 * What acting on the decision does to the provider prompt cache.
 * `prefix-mutating` decisions rewrite earlier context and should only be
 * applied at cache boundaries.
 */
export type CacheImpact = 'none' | 'append-only' | 'prefix-mutating'

/** `inline` blocks the agent loop, `parallel` races other work, `background` never blocks. */
export type LatencyClass = 'inline' | 'parallel' | 'background'

export interface DecisionSpec<In, Qs extends Questions, Out extends JsonValue> {
  readonly id: string
  /** Bump whenever question wording or policy changes, so ledger records stay comparable. */
  readonly version: number
  readonly questions: Qs
  /**
   * Questions built from the input, one per candidate, for decisions over a
   * list whose length is only known at run time. When set, `questions` may be
   * empty and `policy` receives answers keyed by these ids.
   */
  readonly questionsFor?: (input: In) => Questions
  readonly cacheImpact: CacheImpact
  readonly latency: LatencyClass
  /** Set only when every choice question's option set is truly closed. */
  readonly allowChoicesWithoutEscape?: boolean
  /** Digest the input into a small state: summaries and metadata, not bulk text. */
  buildState(input: In): JudgeInput
  policy(answers: AnswersFor<Qs>, input: In): Out | Abstain
  /** Deterministic default, equal to the host's behavior without a judge. */
  fallback(input: In): Out
}

export function defineDecision<In, const Qs extends Questions, Out extends JsonValue>(
  spec: DecisionSpec<In, Qs, Out>,
): DecisionSpec<In, Qs, Out> {
  if (!Number.isInteger(spec.version) || spec.version < 1) {
    throw new TypeError(`Decision "${spec.id}" needs a positive integer version`)
  }
  if (spec.questionsFor === undefined) validateQuestions(spec.questions)
  if (spec.allowChoicesWithoutEscape !== true) {
    for (const [questionId, question] of Object.entries(spec.questions)) {
      if (question.type === 'choice' && !hasEscapeOption(question)) {
        throw new TypeError(
          `Choice question "${questionId}" in decision "${spec.id}" has no escape option (none, other, unclear, unknown)`,
        )
      }
    }
  }
  return spec
}
