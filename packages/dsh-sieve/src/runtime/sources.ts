/**
 * Message sources of everything sieve's harness modules inject into a model's
 * context. `sieve-hive` carries what the hive tells a bee (notes, corrections,
 * checkpoints, last calls); `sieve-notice` carries every other prompt
 * (monitor, rewind proposals, resume classification, team notices). Both are
 * logged `user/message` events, so the session log reconstructs them, and a
 * session restores with or without sieve mounted
 * (tests/contracts/sieve-source-restore.spec.ts).
 * @module
 */

import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'

/** Which sieve module produced a notice. */
export type NoticeTopic = 'monitor' | 'rewind' | 'resume' | 'team' | 'hive'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'sieve-hive': { kind: 'sieve-hive', bee: string } & ContextFormed
    'sieve-notice': { kind: 'sieve-notice', topic: NoticeTopic } & ContextFormed
  }
}

/** What the hive tells one bee, as a logged notice. */
export function hiveMessage(bee: string, text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'sieve-hive', bee, form: 'notice', summary: boundContextSummary(summary) },
  })
}

/** A sieve prompt outside the hive, as a logged notice. */
export function sieveNotice(topic: NoticeTopic, text: string, summary: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'sieve-notice', topic, form: 'notice', summary: boundContextSummary(summary) },
  })
}

/** Whether a message is one sieve injected. */
export function isSieveSource(message: Pick<UserMessage, 'source'>): boolean {
  return message.source.kind === 'sieve-hive' || message.source.kind === 'sieve-notice'
}
