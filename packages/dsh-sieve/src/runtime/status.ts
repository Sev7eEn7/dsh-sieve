/** Folds a session's ledger and the current modes into the JSON status snapshot. */
import type { DecisionMode } from '../judge/decision.ts'
import type { LedgerRecord } from '../judge/ledger.ts'
import { DSH_TEXT_CHARS_PER_TOKEN } from '../status.ts'
import type { SieveDecisionStatus, SieveLatency, SieveRecordSummary, SieveReduction, SieveStatus, SieveUsageTotals } from '../status.ts'
import { DECISION_IDS } from './config.ts'
import type { DecisionId, ResolvedConfig } from './config.ts'

/** Records listed by default; the ledger keeps up to 1000 per session. */
export const DEFAULT_RECENT_RECORDS = 20
/** Upper bound a caller may ask for, so one status stays a small payload. */
export const MAX_RECENT_RECORDS = 200
/** Characters of compact outcome JSON kept per listed record. */
const OUTCOME_CHARS = 240

export interface StatusInput {
  readonly sessionId: string
  readonly live: boolean
  readonly config: ResolvedConfig
  readonly recording: boolean
  readonly records: readonly LedgerRecord[]
  readonly reducedResults: number | null
  /** Route-priced tokens of the current request surface; null without a live agent or token meter. */
  readonly contextTokens: number | null
  readonly modeOf: (id: DecisionId) => DecisionMode
  readonly overridden: (id: DecisionId) => boolean
  readonly recent: number
}

const ZERO_USAGE: SieveUsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }

function addUsage(total: SieveUsageTotals, record: LedgerRecord): SieveUsageTotals {
  const usage = record.usage
  if (usage === undefined) return total
  return {
    inputTokens: total.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: total.outputTokens + (usage.outputTokens ?? 0),
    cacheReadTokens: total.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: total.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    reasoningTokens: total.reasoningTokens + (usage.reasoningTokens ?? 0),
  }
}

function sumUsage(records: readonly LedgerRecord[]): SieveUsageTotals {
  return records.reduce(addUsage, ZERO_USAGE)
}

/** Nearest-rank percentile of sorted values. */
function percentile(sorted: readonly number[], share: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))] ?? 0
}

function latencyOf(records: readonly LedgerRecord[]): SieveLatency | null {
  const values = records
    .filter(record => record.source !== 'rules' && record.latencyMs !== undefined)
    .map(record => record.latencyMs as number)
    .sort((a, b) => a - b)
  return values.length === 0 ? null : { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }
}

function featureEnabled(config: ResolvedConfig, id: DecisionId): boolean {
  switch (id) {
    case 'tool.admission': return config.admission.enabled
    case 'tool.admission.test-log': return config.admission.enabled && config.admission.testLog !== 'off'
    case 'context.forget': return config.forgetting.enabled
    case 'skills.disclosure': return config.skillDisclosure.enabled
  }
}

function compactJson(value: unknown): string {
  const text = JSON.stringify(value) ?? 'null'
  return text.length <= OUTCOME_CHARS ? text : `${text.slice(0, OUTCOME_CHARS - 1)}…`
}

function summarize(record: LedgerRecord): SieveRecordSummary {
  return {
    id: record.id,
    timestamp: record.timestamp,
    specId: record.specId,
    mode: record.mode,
    source: record.source,
    reason: record.reason ?? null,
    outcome: compactJson(record.outcome),
    batchSize: record.batch?.size ?? null,
    latencyMs: record.latencyMs ?? null,
    inputTokens: record.usage?.inputTokens ?? null,
    outputTokens: record.usage?.outputTokens ?? null,
    savedChars: record.savedChars ?? null,
    applied: record.applied ?? null,
  }
}

/**
 * What applied records removed from the model-facing context, priced at DSH's
 * token meter text density, against the current request surface.
 */
export function reductionOf(records: readonly LedgerRecord[], contextTokens: number | null): SieveReduction {
  const chars = records.reduce((sum, record) => sum + (record.applied === true ? record.savedChars ?? 0 : 0), 0)
  const tokens = Math.ceil(chars / DSH_TEXT_CHARS_PER_TOKEN)
  const whole = contextTokens === null ? 0 : contextTokens + tokens
  return { chars, tokens, contextTokens, ratio: contextTokens === null ? null : whole === 0 ? 0 : tokens / whole, charsPerToken: DSH_TEXT_CHARS_PER_TOKEN }
}

export function buildStatus(input: StatusInput): SieveStatus {
  const { config, records } = input
  const decisions = DECISION_IDS.map((id): SieveDecisionStatus => {
    const own = records.filter(record => record.specId === id)
    return {
      id,
      enabled: featureEnabled(config, id),
      mode: input.modeOf(id),
      profileMode: config.modes.get(id) ?? config.defaultMode,
      overridden: input.overridden(id),
      records: own.length,
      rules: own.filter(record => record.source === 'rules').length,
      judged: own.filter(record => record.source === 'judge').length,
      fallbacks: own.filter(record => record.source === 'fallback').length,
      applied: own.filter(record => record.applied === true).length,
      savedChars: own.reduce((sum, record) => sum + (record.savedChars ?? 0), 0),
      usage: sumUsage(own),
      latency: latencyOf(own),
    }
  })
  const count = Math.min(MAX_RECENT_RECORDS, Math.max(0, Math.floor(input.recent)))
  return {
    v: 3,
    sessionId: input.sessionId,
    live: input.live,
    judge: { type: config.judge.type, timeoutMs: config.judge.timeoutMs },
    recording: input.recording,
    testLog: config.admission.testLog,
    reducedResults: input.reducedResults,
    reduction: reductionOf(records, input.contextTokens),
    decisions,
    totals: {
      records: records.length,
      applied: records.filter(record => record.applied === true).length,
      savedChars: records.reduce((sum, record) => sum + (record.savedChars ?? 0), 0),
      judged: records.filter(record => record.source === 'judge').length,
      usage: sumUsage(records),
    },
    recent: count === 0 ? [] : records.slice(-count).reverse().map(summarize),
  }
}
