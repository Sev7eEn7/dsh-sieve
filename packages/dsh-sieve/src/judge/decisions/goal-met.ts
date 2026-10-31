/**
 * `goal.met`: whether the goal the user set holds when the agent marks it
 * complete. The user states a condition once and leaves; the agent's
 * `update_goal complete` is the claim this decision checks.
 *
 * What the harness knows outranks what the closing message claims: an edit
 * nothing ran after means "not yet" whatever the message says. The judge
 * only reads the message.
 *
 * Ported from mu `packages/kyrn-judge/src/decisions/goal-met.ts`.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * sieve has no task frame, so mu's open acceptance items are dropped from the
 * input and the state; the questions and the rest of the policy are mu's, so
 * the version stays mu's.
 * @module
 */

import { defineDecision } from '../decision.ts'
import { threeZone } from '../policy.ts'

export interface GoalInput {
  readonly goal: string
  readonly finalMessage: string
  /** Files were edited and nothing ran afterwards. */
  readonly unverified: boolean
}

/**
 * `ask`: the agent cannot go on without the user. `unjudged`: there is no
 * fact to continue on and nobody to read the message, so the user decides.
 */
export type GoalOutcome = 'met' | 'continue' | 'ask' | 'unjudged'

export const goalMet = defineDecision({
  id: 'goal.met',
  version: 1,
  questions: {
    achieved: { type: 'boolean', instructions: 'Does `final_message` say that `goal` is fully achieved?' },
    needs_user: {
      type: 'boolean',
      instructions: 'Does `final_message` ask the user for something the work cannot go on without?',
    },
  },
  buildState(input: GoalInput) {
    return {
      goal: input.goal,
      final_message: input.finalMessage,
      edited_without_running_anything: input.unverified,
    }
  },
  policy(answers, input): GoalOutcome {
    // A question to the user is never answered by working on: that is how an agent digs the wrong hole deeper.
    if (threeZone(answers.needs_user) === 'yes') return 'ask'
    if (input.unverified) return 'continue'
    return threeZone(answers.achieved) === 'yes' ? 'met' : 'continue'
  },
  /** Without a judge the facts still count: work that is provably unfinished goes on, the rest is the user's call. */
  fallback(input): GoalOutcome {
    return input.unverified ? 'continue' : 'unjudged'
  },
})
