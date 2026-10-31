/**
 * Signals sieve's modules pass to each other inside one process: plain Cordis
 * events, never Session events. The monitor says when an agent goes in
 * circles or drifts from its goal; checkpoints listen and may ask
 * `turn.rewind` whether the approach is a dead end.
 * @module
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** `loop`: the same call ended the same way again and again. `drift`: the judge found the steps unrelated to the goal. */
export type TroubleKind = 'loop' | 'drift' | 'stalled'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The monitor saw an agent in trouble, in shadow as in active mode.
     * @mode emit
     */
    'sieve/trouble'(agent: Agent, kind: TroubleKind, detail: string): void
  }
}
