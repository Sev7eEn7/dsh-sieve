/**
 * sieve's profile configuration: which judge answers, in which mode each
 * decision runs, and what the ledger keeps. The schema carries the defaults;
 * `resolveConfig` rejects what the schema cannot express, so a bad profile
 * fails at load instead of silently falling back.
 * @module
 */

import z from '@deepseek-ai/schemastery'
import { DECISION_MODES } from '../judge/decision.ts'
import type { DecisionMode } from '../judge/decision.ts'

/** The decisions of the first release (migration plan §1); no others are registered. */
export const DECISION_IDS = ['tool.admission', 'tool.admission.test-log', 'context.forget', 'skills.disclosure'] as const
export type DecisionId = typeof DECISION_IDS[number]

/** Node caps timers at 2^31 - 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

export type JudgeType = 'llm' | 'system-one' | 'off'

export interface JudgeConfig {
  /**
   * `llm`: a model route through DSH `ctx.llm`, no extra account.
   * `system-one`: Jev over HTTP (TypeSafe or OpenRouter), needs `apiKey`.
   * `off`: no judge; every decision takes its fallback.
   */
  type: JudgeType
  /** llm: provider route, together with `model`; leave both out to use the session's own route. */
  provider?: string
  /** llm: model id for `provider`. system-one: judge model, default `jev-latest`. */
  model?: string
  /** system-one: endpoint, default TypeSafe's. */
  baseUrl?: string
  /** system-one: the key, e.g. `!!js process.env.TYPESAFE_API_KEY`. */
  apiKey?: string
  /** Deadline of one judge call, end to end. */
  timeoutMs: number
  /** llm: output token cap of one judge call. */
  maxOutputTokens: number
}

export interface Config {
  judge: JudgeConfig
  /** Mode per decision id; `default` covers the rest. */
  modes: Record<string, DecisionMode>
  /** Store submitted judge states in the ledger. Off by default because states can hold user content. */
  recordState: boolean
}

export const Config: z<Config> = z.object({
  judge: z.object({
    type: z.union(['llm', 'system-one', 'off'] as const).default('llm'),
    provider: z.string(),
    model: z.string(),
    baseUrl: z.string(),
    apiKey: z.string(),
    timeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(4000),
    maxOutputTokens: z.natural().min(1).default(1024),
  }).default({}),
  modes: z.dict(z.union(DECISION_MODES)).default({}),
  recordState: z.boolean().default(false),
})

export interface LlmRoute {
  readonly provider: string
  readonly model: string
}

export type ResolvedJudge =
  | { readonly type: 'off' }
  | {
    readonly type: 'llm'
    /** Undefined: the session's own route at call time. */
    readonly route: LlmRoute | undefined
    readonly timeoutMs: number
    readonly maxOutputTokens: number
  }
  | {
    readonly type: 'system-one'
    readonly apiKey: string
    readonly baseUrl: string | undefined
    readonly model: string | undefined
    readonly timeoutMs: number
  }

export interface ResolvedConfig {
  readonly judge: ResolvedJudge
  readonly defaultMode: DecisionMode
  readonly modes: ReadonlyMap<DecisionId, DecisionMode>
  readonly recordState: boolean
}

const MODE_KEYS: ReadonlySet<string> = new Set(['default', ...DECISION_IDS])

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/**
 * Validate a configuration and detach it from the caller.
 * @param config - raw or schema-validated configuration.
 * @returns the immutable configuration sieve runs on.
 */
export function resolveConfig(config: Partial<Config> | undefined): ResolvedConfig {
  const value = Config((config ?? {}) as Config)
  const judge = value.judge

  let resolved: ResolvedJudge
  if (judge.type === 'off') {
    resolved = { type: 'off' }
  } else if (judge.type === 'llm') {
    const provider = nonEmpty(judge.provider)
    const model = nonEmpty(judge.model)
    if ((provider === undefined) !== (model === undefined)) {
      throw new Error('sieve: judge.provider and judge.model must be set together')
    }
    resolved = {
      type: 'llm',
      route: provider === undefined || model === undefined ? undefined : { provider, model },
      timeoutMs: judge.timeoutMs,
      maxOutputTokens: judge.maxOutputTokens,
    }
  } else {
    const apiKey = nonEmpty(judge.apiKey)
    if (apiKey === undefined) throw new Error('sieve: judge.type system-one needs judge.apiKey')
    resolved = {
      type: 'system-one',
      apiKey,
      baseUrl: nonEmpty(judge.baseUrl),
      model: nonEmpty(judge.model),
      timeoutMs: judge.timeoutMs,
    }
  }

  const modes = new Map<DecisionId, DecisionMode>()
  for (const [key, mode] of Object.entries(value.modes)) {
    if (!MODE_KEYS.has(key)) {
      throw new Error(`sieve: unknown decision "${key}" in modes; known: default, ${DECISION_IDS.join(', ')}`)
    }
    if (key !== 'default') modes.set(key as DecisionId, mode)
  }

  return Object.freeze({
    judge: Object.freeze(resolved),
    defaultMode: value.modes['default'] ?? 'shadow',
    modes,
    recordState: value.recordState,
  })
}
