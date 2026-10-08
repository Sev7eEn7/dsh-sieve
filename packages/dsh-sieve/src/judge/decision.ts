/**
 * Decision specs: what a judge is asked at one decision point, and how its
 * answers become an outcome the host acts on.
 *
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * Fields nothing in sieve reads are dropped: the
 * cascade-only `capabilities`, the descriptive `cacheImpact` and `latency`, and
 * `allowChoicesWithoutEscape`, whose check never saw the questions built per
 * input. tests/judge/decisions.spec.ts checks that every choice question of the
 * shipped decisions has an escape option.
 * @module
 */

import { validateQuestions } from './judge.ts'
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
  return spec
}
