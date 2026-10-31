/**
 * `resume.safety`, crash-resume classification: a session that died while a
 * tool ran comes back with that call's outcome unknown (DSH answers it with
 * `TOOL_OUTCOME_UNKNOWN`). Whether to simply run it again depends on what the
 * call does: `pnpm install`, `git rebase` and `rm -rf dist && build` cut off
 * halfway call for very different next steps. A call the change rules find
 * read-only needs no judge; the rest is one choice.
 *
 * New in sieve (harness plan §4 phase 5); no mu counterpart.
 * @module
 */

import { defineDecision } from '../decision.ts'
import { pickChoice } from '../policy.ts'

export interface ResumeInput {
  /** The tool's name, e.g. `bash`. */
  readonly tool: string
  /** The call in one line, e.g. `bash: pnpm install`. */
  readonly call: string
  /** Its arguments as JSON, clipped. */
  readonly arguments: string
  /** Whether the change rules say it can change files (`isMutatingCall`). */
  readonly changesFiles: boolean
  /** The request the interrupted turn worked on. */
  readonly request: string
}

export type ResumeOutcome = 'read_only' | 'idempotent' | 'verify_first' | 'unsafe' | 'unknown'

export const resumeSafety = defineDecision({
  id: 'resume.safety',
  version: 1,
  questions: {
    effect: {
      type: 'choice',
      instructions: 'The session stopped while `call` ran, so nobody knows whether it finished. What does running it again do?',
      criteria: {
        read_only: 'Nothing: it only reads',
        idempotent: 'It reaches the same end state whether or not the first run finished, e.g. writing the same file, `mkdir -p`, a formatter',
        verify_first: 'It may have partly happened, and the state has to be checked before running it again, e.g. an install, a build that writes outputs, a migration, `git rebase`',
        unsafe: 'It could repeat or worsen its effects, e.g. deleting, moving, sending, publishing, appending, a migration that is not idempotent',
        other: 'Cannot tell',
      },
    },
  },
  buildState(input: ResumeInput) {
    return {
      call: input.call,
      tool: input.tool,
      arguments: input.arguments,
      changes_files: input.changesFiles,
      request: input.request,
    }
  },
  policy(answers): ResumeOutcome {
    return pickChoice(answers.effect, { minProbability: 0.6 }) ?? 'unknown'
  },
  fallback(): ResumeOutcome {
    return 'unknown'
  },
})
