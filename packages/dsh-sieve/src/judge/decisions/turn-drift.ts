/**
 * `turn.drift`, the drift monitor: every few tool rounds, are the recent
 * actions still serving the goal?
 *
 * Ported from mu `packages/kyrn-judge/src/decisions/turn-drift.ts`.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * Questions and policy are mu's, so the version stays mu's.
 * @module
 */

import { defineDecision } from '../decision.ts'
import { pickChoice } from '../policy.ts'

export interface DriftInput {
  readonly goal: string
  /** One line per recent action, newest last. */
  readonly recentActions: readonly string[]
}

export type DriftOutcome = 'on_track' | 'detour' | 'drift' | 'loop' | 'unknown'

export const turnDrift = defineDecision({
  id: 'turn.drift',
  version: 1,
  questions: {
    course: {
      type: 'choice',
      instructions: 'How do `recent_actions` relate to `goal`?',
      criteria: {
        on_track: 'They work directly on the goal',
        detour: 'A necessary side step that leads back to the goal',
        drift: 'They have moved to something the goal does not need',
        loop: 'The same action repeats without progress',
        other: 'Cannot tell',
      },
    },
  },
  buildState(input: DriftInput) {
    return { goal: input.goal, recent_actions: [...input.recentActions] }
  },
  policy(answers): DriftOutcome {
    return pickChoice(answers.course, { minProbability: 0.7 }) ?? 'unknown'
  },
  fallback(): DriftOutcome {
    return 'unknown'
  },
})
