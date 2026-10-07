/**
 * One session's sieve state as plain JSON: what `/sieve status` prints and
 * what the dsh-sieve-web panel reads over its Connection channel. Types only,
 * so a browser bundle can import them without pulling in the host plugin.
 *
 * `savedChars` here is the ledger's estimate of model-facing characters not
 * sent; it does not count re-reads, cache invalidation or judge cost, and is
 * not a measured saving (migration plan §7).
 * @module dsh-sieve/status
 */

import type { DecisionMode } from './judge/decision.ts'
import type { DecisionId, JudgeType } from './runtime/config.ts'

export type { DecisionId, DecisionMode, JudgeType }

/** Bumped when a field changes meaning or a required one is added; readers reject other versions. */
export type SieveStatusVersion = 3

/** Text density of DSH's token meter heuristic (`dsh-token-meter` estimate.ts, `CHARS_PER_TOKEN`). */
export const DSH_TEXT_CHARS_PER_TOKEN = 4

/**
 * Model-facing context removed by decisions that were applied (active mode).
 * Counts what was cut when it was cut; a later DSH compaction that drops the
 * same content is not subtracted.
 */
export interface SieveReduction {
  /** Characters removed: the ledger's `savedChars` summed over applied records. */
  readonly chars: number
  /** `chars` priced at DSH's token meter text density ({@link DSH_TEXT_CHARS_PER_TOKEN}). */
  readonly tokens: number
  /** Route-priced tokens of the session's current request surface (DSH token meter); null without a live agent or meter. */
  readonly contextTokens: number | null
  /** `tokens / (contextTokens + tokens)`: the share of the unreduced request context removed; null when `contextTokens` is. */
  readonly ratio: number | null
  /** The density `tokens` was priced at. */
  readonly charsPerToken: number
}

/** Services that serve Jev over System One, in the order an `auto` judge tries their keys. */
export type JevService = 'typesafe' | 'openrouter'

/** One service's Jev key as a configuration surface sees it: never the value. */
export interface JevKeyInfo {
  readonly service: JevService
  /** The DSH credential reference (an environment-variable name) holding the key. */
  readonly ref: string
  readonly configured: boolean
  /** Source layer supplying the value, such as `env` or `file`; null while unconfigured. */
  readonly source: string | null
  /** Whether the store can write this reference; a key from the process environment cannot be. */
  readonly writable: boolean
}

/** Which judge answers and which Jev keys exist. */
export interface SieveJudgeStatus {
  /** The profile's judge type. */
  readonly type: JudgeType
  /** What the next judgment uses; `none` (an `auto` judge without a Jev key) means sieve changes nothing. */
  readonly using:
    | { readonly kind: 'jev', readonly service: JevService | null }
    | { readonly kind: 'laya' }
    | { readonly kind: 'none' }
  /** Stored keys; only an `auto` judge reads them. */
  readonly keys: readonly JevKeyInfo[]
}

export interface SieveUsageTotals {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
}

/** Judge latency over the records that called one; null when none did. */
export interface SieveLatency {
  readonly p50: number
  readonly p95: number
}

export interface SieveDecisionStatus {
  readonly id: DecisionId
  /** The profile's feature switch; a disabled feature never decides, whatever its mode. */
  readonly enabled: boolean
  /** The mode this session's next decision runs in. */
  readonly mode: DecisionMode
  /** The mode the profile gives this decision. */
  readonly profileMode: DecisionMode
  /** Whether this session overrides the profile mode. */
  readonly overridden: boolean
  readonly records: number
  /** Records decided by deterministic rules, without a judge. */
  readonly rules: number
  /** Records whose judge call succeeded. */
  readonly judged: number
  /** Records that took the fallback: shadow, abstain or a failed call. */
  readonly fallbacks: number
  readonly applied: number
  readonly savedChars: number
  readonly usage: SieveUsageTotals
  readonly latency: SieveLatency | null
}

/** One ledger record without the submitted state or per-question answers. */
export interface SieveRecordSummary {
  readonly id: string
  readonly timestamp: string
  readonly specId: string
  readonly mode: 'shadow' | 'active'
  readonly source: 'judge' | 'fallback' | 'rules'
  /** Why the fallback was used: "shadow", "abstain" or "error:<kind>". */
  readonly reason: string | null
  /** The outcome the host acted on, as compact JSON cut to a bounded length. */
  readonly outcome: string
  /** Inputs covered by a batch record; null for a single decision. */
  readonly batchSize: number | null
  readonly latencyMs: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  /** Unknown until the host annotates the record. */
  readonly savedChars: number | null
  readonly applied: boolean | null
}

export interface SieveStatus {
  readonly v: SieveStatusVersion
  readonly sessionId: string
  /**
   * Whether an agent of this session is loaded in this process. Mode
   * overrides live only as long as one is, and the log marker count needs one.
   */
  readonly live: boolean
  readonly judge: {
    readonly type: JudgeType
    /** Deadline of one judge call. */
    readonly timeoutMs: number
  }
  /** Whether the ledger is mounted; without it nothing below is recorded. */
  readonly recording: boolean
  readonly testLog: 'off' | 'rules' | 'judge'
  /** Tool results in the log that carry a sieve archive marker; null without a live agent. */
  readonly reducedResults: number | null
  readonly reduction: SieveReduction
  readonly decisions: readonly SieveDecisionStatus[]
  readonly totals: {
    readonly records: number
    readonly applied: number
    readonly savedChars: number
    readonly judged: number
    readonly usage: SieveUsageTotals
  }
  /** Newest first, at most the requested count. */
  readonly recent: readonly SieveRecordSummary[]
}
