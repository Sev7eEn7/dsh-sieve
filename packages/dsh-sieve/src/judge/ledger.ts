/**
 * Ledger records: one per judged decision (or one per batch), kept so §7 of
 * the migration plan can price every judge call against what it saved.
 *
 * Field set adapted from mu `packages/kyrn-judge/src/ledger.ts` (MIT, see
 * THIRD_PARTY_NOTICES.md). Usage is complete: mu's batch records wrote output
 * tokens as 0, which made judge cost unmeasurable.
 * @module
 */

import type { Answer, JsonValue, JudgeUsage, JudgeWarning } from './types.ts'

/** Version of the record shape; bump when a field changes meaning. */
export const LEDGER_RECORD_VERSION = 1

export interface LedgerRecord {
  readonly v: typeof LEDGER_RECORD_VERSION
  readonly id: string
  /** When the record was written. A slow judge answers long after it was asked. */
  readonly timestamp: string
  /** What the caller passed as `origin` when it asked, such as the tool call id. */
  readonly origin?: JsonValue | undefined
  readonly specId: string
  readonly specVersion: number
  readonly mode: 'shadow' | 'active'
  readonly providerId: string
  readonly modelId?: string | undefined
  /** What the caller acted on. */
  readonly outcome: JsonValue
  readonly source: 'judge' | 'fallback'
  /** Why the fallback was used: "shadow", "abstain", or "error:<kind>". */
  readonly reason?: string | undefined
  /** What the judge path produced, when the call succeeded. */
  readonly judged?: JsonValue | undefined
  readonly answers?: Readonly<Record<string, Answer>> | undefined
  readonly latencyMs?: number | undefined
  readonly usage?: JudgeUsage | undefined
  readonly warnings?: readonly JudgeWarning[] | undefined
  /** Set when the record covers many inputs of one spec; `outcome` and `judged` are arrays then. */
  readonly batch?: {
    readonly size: number
    readonly failures: number
    /** Per-item answers, kept only for small batches. */
    readonly answers?: readonly (Readonly<Record<string, Answer>> | null)[] | undefined
  } | undefined
  /** Whether the host acted on the outcome, set once it knows; absent until then. */
  readonly applied?: boolean | undefined
  /** SHA-256 of the submitted state. The state itself is stored only when the engine is told to. */
  readonly stateDigest: string
  readonly state?: JsonValue | undefined
}

export interface LedgerSink {
  append(record: LedgerRecord): void | Promise<void>
}

/** Keeps the latest records in memory, for tests and status displays. */
export class MemoryLedger implements LedgerSink {
  readonly records: LedgerRecord[] = []
  private readonly capacity: number

  constructor(capacity = 500) {
    this.capacity = capacity
  }

  append(record: LedgerRecord): void {
    this.records.push(record)
    if (this.records.length > this.capacity) this.records.shift()
  }
}
