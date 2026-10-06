/**
 * Why a judge call failed. Callers never branch on message text.
 *
 * Ported from mu `packages/kyrn-judge/src/errors.ts` (MIT, see THIRD_PARTY_NOTICES.md).
 *
 * - `auth`: no usable key, or no judge configured at all. The next call fails
 *   the same way until the user sets one up.
 * - `payment_required`: the account behind the key cannot service requests yet.
 * @module
 */

import type { JudgeUsage } from './types.ts'

export type JudgeErrorKind =
  | 'timeout'
  | 'aborted'
  | 'unreachable'
  | 'auth'
  | 'payment_required'
  | 'rate_limited'
  | 'bad_request'
  | 'server'
  | 'invalid_response'

export class JudgeError extends Error {
  readonly kind: JudgeErrorKind
  readonly status: number | undefined
  /** What the failed call still cost, when the provider reported it (an invalid reply is paid for). */
  readonly usage: JudgeUsage | undefined

  constructor(kind: JudgeErrorKind, message: string, options?: { status?: number | undefined, cause?: unknown, usage?: JudgeUsage | undefined }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'JudgeError'
    this.kind = kind
    this.status = options?.status
    this.usage = options?.usage
  }
}

export function isJudgeError(error: unknown): error is JudgeError {
  return error instanceof JudgeError
}
