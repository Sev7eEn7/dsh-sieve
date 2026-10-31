/**
 * `tool.approval`: Jev approves for the user. Under DSH's Auto preset a call
 * that would otherwise need the user (a command, a change outside the
 * project, an action on the outside world, a sub-agent) is put to the judge
 * first: is it a step the task needs, done the way the user would expect?
 * Only a sure yes lets it run. Anything else, and no verdict at all, goes to
 * the user, with what Jev saw.
 *
 * One choice question rather than booleans: choice distributions are sharp on
 * clear cases, and "beyond" versus "unrelated" tells the user why they are
 * being asked.
 *
 * Ported from mu `packages/kyrn-judge/src/decisions/tool-approval.ts`.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * @module
 */

import { defineDecision } from '../decision.ts'
import { isEscapeOption } from '../policy.ts'

export interface ToolApprovalInput {
  /** The task the session works on: its first request, and the current one when it differs. */
  readonly task: string
  readonly userMessage: string
  /** "bash: npm install lodash", "write /etc/hosts". */
  readonly call: string
  /** Where the call acts, said plainly: "a program run in the project folder" or where else. */
  readonly where: string
}

export type ToolApprovalOutcome = 'approve' | 'beyond' | 'unrelated' | 'unsure'

/** How sure Jev has to be that a step is needed before it runs without the user. */
export const APPROVE_AT = 0.8

export const toolApproval = defineDecision({
  id: 'tool.approval',
  version: 1,
  questions: {
    verdict: {
      type: 'choice',
      instructions: 'What is `tool_call`, for `task` and `user_message`?',
      criteria: {
        needed: 'A step the task needs, done the way the user would expect',
        beyond: 'More than the user asked for: it deletes, overwrites, installs, publishes, sends or spends something, or acts outside the project, without being asked to',
        unrelated: 'Not part of the task',
        unclear: 'Cannot tell from what is here',
      },
    },
  },
  // Decisive content first: a judge with a bounded window keeps the head of the state.
  buildState(input: ToolApprovalInput) {
    return { tool_call: input.call, where: input.where, task: input.task, user_message: input.userMessage }
  },
  policy(answers): ToolApprovalOutcome {
    const { choice, probabilities } = answers.verdict
    if (isEscapeOption(choice)) return 'unsure'
    const p = probabilities?.[choice]
    if (choice === 'needed') return p === undefined || p >= APPROVE_AT ? 'approve' : 'unsure'
    return choice === 'beyond' || choice === 'unrelated' ? choice : 'unsure'
  },
  // Nobody could look at it: the user decides.
  fallback(): ToolApprovalOutcome {
    return 'unsure'
  },
})
