/**
 * Ledger records: one per judged decision (or one per batch), kept so §7 of
 * the migration plan can price every judge call against what it saved.
 *
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * Usage is complete, batch records included, so judge cost stays measurable.
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
  /** `rules`: a deterministic outcome reached without a judge, recorded so its effect is measured too. */
  readonly source: 'judge' | 'fallback' | 'rules'
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
  /**
   * Net model-facing characters this record's verdict saves (or would save, in
   * shadow) beyond what is omitted without it, set by the host. Estimated the
   * same way in every mode, so shadow and active records compare; 0 when the
   * result would not pass the host's minimum saving.
   */
  readonly savedChars?: number | undefined
  /** SHA-256 of the submitted state. The state itself is stored only when the engine is told to. */
  readonly stateDigest: string
  readonly state?: JsonValue | undefined
}

/** What the host learns about a record after it is written. */
export type LedgerAnnotation = Partial<Pick<LedgerRecord, 'applied' | 'savedChars'>>

export interface LedgerSink {
  append(record: LedgerRecord): void | Promise<void>
}
