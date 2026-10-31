/**
 * The team supervisor's decisions (harness plan §4 phase 6). DSH's agent
 * team keeps a task board; nobody watches it. These judge what a person
 * supervising the team would: whether a task marked done is done
 * (`team.verify`), whether an edit steps on another member's task
 * (`team.conflict`), and which idle member should take a ready task
 * (`team.dispatch`). `team.release` has no question: a member the monitor
 * keeps finding stuck is released by rule, and the ledger records it.
 *
 * All four start in shadow (D5): they change what a team does.
 *
 * New in sieve.
 * @module
 */

import { defineDecision } from '../decision.ts'
import { pickChoice, threeZone } from '../policy.ts'
import type { Questions } from '../types.ts'

/** Rules only: the identity its ledger records carry. */
export const teamRelease = { id: 'team.release', version: 1 } as const

export interface VerifyInput {
  readonly task: string
  readonly description: string
  /** The owner's recent steps with their outcome, oldest first: "bash: pnpm test -> failed". */
  readonly steps: readonly string[]
  /** Whether the owner's latest test, build or lint run failed; undefined when none ran. */
  readonly lastCheckFailed?: boolean | undefined
  /** Files the owner changed in the turn it completed the task. */
  readonly edits: number
}

/** `unsure` is for a read-only verifier to settle. */
export type VerifyOutcome = 'accept' | 'reopen' | 'unsure'

export const teamVerify = defineDecision({
  id: 'team.verify',
  version: 1,
  questions: {
    done: { type: 'boolean', instructions: 'Does `steps` show the work `task` asks for done?' },
    failing: { type: 'boolean', instructions: 'Does `steps` show a test, build or check that still fails?' },
  },
  buildState(input: VerifyInput) {
    return {
      task: input.task,
      description: input.description,
      steps: [...input.steps],
      last_check_failed: input.lastCheckFailed ?? null,
      files_changed: input.edits,
    }
  },
  policy(answers): VerifyOutcome {
    if (threeZone(answers.failing) === 'yes') return 'reopen'
    if (threeZone(answers.done) === 'yes' && threeZone(answers.failing) === 'no') return 'accept'
    return threeZone(answers.done) === 'no' ? 'reopen' : 'unsure'
  },
  // Nobody could look at it: the task stays as its owner left it.
  fallback(): VerifyOutcome {
    return 'accept'
  },
})

export interface ConflictInput {
  /** "write src/parser/lexer.ts". */
  readonly edit: string
  /** The task the editing member works on, when it has one. */
  readonly mine: string
  /** The other member's task whose write scope the edit falls in. */
  readonly theirs: string
  readonly owner: string
  readonly scope: string
}

export type ConflictOutcome = 'allow' | 'hold'

export const teamConflict = defineDecision({
  id: 'team.conflict',
  version: 1,
  questions: {
    conflict: {
      type: 'boolean',
      instructions: 'Would `edit`, made for `my_task`, interfere with `their_task`, which another member is working on in `scope`?',
    },
  },
  buildState(input: ConflictInput) {
    return { edit: input.edit, my_task: input.mine, their_task: input.theirs, their_owner: input.owner, scope: input.scope }
  },
  policy(answers): ConflictOutcome {
    return threeZone(answers.conflict) === 'no' ? 'allow' : 'hold'
  },
  // A shared write nobody could weigh waits for the members to agree.
  fallback(): ConflictOutcome {
    return 'hold'
  },
})

export interface DispatchInput {
  readonly task: string
  readonly description: string
  /** Idle members by name, with what each does. */
  readonly members: Readonly<Record<string, string>>
}

/** A member's name, or null to leave the task on the board. */
export type DispatchOutcome = string | null

/** How sure the judge must be of a member before the task is assigned without the Lead. */
export const DISPATCH_AT = 0.8

export const teamDispatch = defineDecision({
  id: 'team.dispatch',
  version: 1,
  questions: {} as Questions,
  questionsFor(input: DispatchInput): Questions {
    return {
      member: {
        type: 'choice',
        instructions: 'Which member should take `task`, by what each does?',
        criteria: { ...input.members, none: 'None of them fits' },
      },
    }
  },
  buildState(input: DispatchInput) {
    return { task: input.task, description: input.description, members: { ...input.members } }
  },
  policy(answers): DispatchOutcome {
    const member = answers['member']
    return member?.type === 'choice' ? (pickChoice(member, { minProbability: DISPATCH_AT }) ?? null) : null
  },
  fallback(): DispatchOutcome {
    return null
  },
})
