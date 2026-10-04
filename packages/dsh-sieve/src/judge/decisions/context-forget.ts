/**
 * `context.forget`: is the full result of an old tool call still worth its
 * tokens? The judge sees the call and its size, never the result body, so
 * judging a 30K output costs a few dozen tokens.
 *
 * Shrinking rewrites earlier context and breaks the cached prefix from that
 * point, so the caller batches these at cache boundaries and keeps them sticky.
 *
 * Ported from mu `packages/kyrn-judge/src/decisions/context-forget.ts` (MIT,
 * see THIRD_PARTY_NOTICES.md); wording, id and version unchanged.
 * @module
 */

import { defineDecision } from '../decision.ts'
import { threeZone } from '../policy.ts'

export interface ForgetInput {
  readonly goal: string
  /** Tool and arguments, e.g. "bash: npm test". */
  readonly call: string
  readonly resultChars: number
  /** User turns since the call. */
  readonly ageTurns: number
  /** What the agent has been doing since, newest last. */
  readonly since: readonly string[]
}

export type ForgetOutcome = 'keep' | 'shrink'

export const contextForget = defineDecision({
  id: 'context.forget',
  version: 1,
  cacheImpact: 'prefix-mutating',
  latency: 'inline',
  questions: {
    still_needed: { type: 'boolean', instructions: 'Will the full output of `call` be needed again for `goal`?' },
  },
  buildState(input: ForgetInput) {
    return {
      call: input.call,
      goal: input.goal,
      result_chars: input.resultChars,
      age_turns: input.ageTurns,
      since: input.since,
    }
  },
  policy(answers): ForgetOutcome {
    return threeZone(answers.still_needed) === 'no' ? 'shrink' : 'keep'
  },
  fallback(): ForgetOutcome {
    return 'keep'
  },
})
