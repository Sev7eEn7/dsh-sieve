/**
 * `tool.risk`, the risk gate. Rules find the commands worth a second look;
 * the judge only answers whether the user asked for this. It can add a
 * confirmation, never remove one: without a verdict a flagged command is
 * confirmed, and "not destructive" alone never runs it (the command can say
 * anything about itself), so the gate also requires `requested`.
 *
 * Ported from mu `packages/kyrn-judge/src/decisions/tool-risk.ts`.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * @module
 */

import { defineDecision } from '../decision.ts'
import { threeZone } from '../policy.ts'

export interface RiskInput {
  readonly command: string
  readonly userMessage: string
  /** Why a rule flagged the command, e.g. "recursive or forced delete". */
  readonly flag: string
}

export type RiskOutcome = 'allow' | 'confirm'

export const toolRisk = defineDecision({
  id: 'tool.risk',
  version: 1,
  questions: {
    destructive: {
      type: 'boolean',
      instructions: 'Does `command` delete data or make a change that cannot be undone?',
    },
    requested: { type: 'boolean', instructions: 'Did `user_message` ask for what `command` does?' },
  },
  buildState(input: RiskInput) {
    return { command: input.command, flag: input.flag, user_message: input.userMessage }
  },
  policy(answers): RiskOutcome {
    if (threeZone(answers.destructive) === 'no') return 'allow'
    return threeZone(answers.requested) === 'yes' ? 'allow' : 'confirm'
  },
  // A rule flagged it and nobody could vouch for it.
  fallback(): RiskOutcome {
    return 'confirm'
  },
})
