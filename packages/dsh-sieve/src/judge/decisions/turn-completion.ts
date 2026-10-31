/**
 * `turn.completion`, the completion gate. Whether files were edited and
 * whether anything ran afterwards are facts the harness already has; the
 * judge only reads the agent's closing message and the nature of the request.
 *
 * Ported from mu `packages/kyrn-judge/src/decisions/turn-completion.ts`.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * mu's version 2 added open acceptance items of the task frame to the policy;
 * sieve has no task frame, so the policy is mu's version 1 and so is the
 * version.
 * @module
 */

import { defineDecision } from '../decision.ts'
import { threeZone } from '../policy.ts'

export interface CompletionInput {
  readonly userMessage: string
  readonly finalMessage: string
  readonly editedFiles: number
  readonly ranCommandAfterLastEdit: boolean
}

export type CompletionOutcome = 'done' | 'nudge'

export const turnCompletion = defineDecision({
  id: 'turn.completion',
  version: 1,
  questions: {
    claims_done: { type: 'boolean', instructions: 'Does `final_message` say the work is finished?' },
    needs_check: {
      type: 'boolean',
      instructions: 'Should the change asked for in `user_message` be checked by running it?',
    },
  },
  buildState(input: CompletionInput) {
    return {
      final_message: input.finalMessage,
      user_message: input.userMessage,
      edited_files: input.editedFiles,
      ran_command_after_last_edit: input.ranCommandAfterLastEdit,
    }
  },
  policy(answers, input): CompletionOutcome {
    if (threeZone(answers.claims_done) !== 'yes') return 'done'
    if (input.editedFiles === 0 || input.ranCommandAfterLastEdit) return 'done'
    return threeZone(answers.needs_check) === 'yes' ? 'nudge' : 'done'
  },
  fallback(): CompletionOutcome {
    return 'done'
  },
})
