/**
 * `turn.rewind`, the judged rewind. The monitor knows THAT the agent goes in
 * circles (a rule) or has drifted; whether the approach itself is a dead end
 * is a judgment. Only a confident dead end with no progress proposes going
 * back to the turn's checkpoint, and proposing is all it does: the user
 * rewinds, never the judge.
 *
 * The cheapest recovery from a dead end is the state before it, plus one line
 * about what was learned, instead of more fixes on a broken path and the whole
 * failed attempt carried in the context.
 *
 * Ported from mu `packages/kyrn-judge/src/decisions/turn-rewind.ts`.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * @module
 */

import { defineDecision } from '../decision.ts'
import { threeZone } from '../policy.ts'

export interface RewindInput {
  readonly goal: string
  /** One line per recent tool call with its outcome, oldest first. */
  readonly recentSteps: readonly string[]
  /** Why the question is asked now, e.g. "the same failing command ran 3 times". */
  readonly trigger: string
  readonly editsSinceCheckpoint: number
  /** Whether the latest test, build or lint run failed; undefined when none ran. */
  readonly lastCheckFailed?: boolean
}

export type RewindOutcome = 'continue' | 'propose'

export const turnRewind = defineDecision({
  id: 'turn.rewind',
  version: 1,
  questions: {
    dead_end: {
      type: 'boolean',
      instructions: 'Does `recent_steps` show the same approach failing again and again?',
    },
    progress: { type: 'boolean', instructions: 'Does `recent_steps` show progress towards `goal`?' },
  },
  buildState(input: RewindInput) {
    return {
      recent_steps: [...input.recentSteps],
      goal: input.goal,
      trigger: input.trigger,
      edits_since_checkpoint: input.editsSinceCheckpoint,
      last_check_failed: input.lastCheckFailed ?? null,
    }
  },
  policy(answers): RewindOutcome {
    return threeZone(answers.dead_end) === 'yes' && threeZone(answers.progress) === 'no' ? 'propose' : 'continue'
  },
  fallback(): RewindOutcome {
    return 'continue'
  },
})
