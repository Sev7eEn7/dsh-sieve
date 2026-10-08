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

export type JudgeType = 'auto' | 'system-one' | 'laya'

/**
 * sieve runs only with a dedicated judge model, Jev or Laya; the session's own
 * model never stands in (user decision, 2026-10-08). Without one, no decision
 * changes anything, rules included.
 */
export interface JudgeConfig {
  /**
   * `auto` (default): Jev over System One with the key DSH's credential store
   * holds (see `runtime/jev.ts`), resolved per call; no key, no judgment.
   * `system-one`: Jev over HTTP (TypeSafe or OpenRouter), needs `apiKey`.
   * `laya`: the local Laya sidecar, no key.
   */
  type: JudgeType
  /** system-one: judge model, default `jev-latest`. */
  model?: string
  /** system-one: endpoint, default TypeSafe's. laya: the sidecar, default `http://127.0.0.1:47823`. */
  baseUrl?: string
  /** system-one: the key, e.g. `!!js process.env.TYPESAFE_API_KEY`. */
  apiKey?: string
  /** Deadline of one judge call, end to end. */
  timeoutMs: number
}

export interface Config {
  judge: JudgeConfig
  /** Mode per decision id; `default` (itself `active` unless set) covers the rest. */
  modes: Record<string, DecisionMode>
  /** Store submitted judge states in the ledger. Off by default because states can hold user content. */
  recordState: boolean
  admission: AdmissionConfig
  forgetting: ForgettingConfig
  skillDisclosure: SkillDisclosureConfig
}

export interface ForgettingConfig {
  enabled: boolean
  /** The most recent tool results stay whole; older ones of at least `minChars` are forgotten. */
  keepRecent: number
  minChars: number
  /**
   * Forgetting rewrites history and costs the cached prefix from the first
   * replaced result on, so it waits until one batch saves at least this many
   * characters.
   */
  minBatchChars: number
  /** Characters of a forgotten result kept at each end. */
  edgeChars: number
  maxPerBatch: number
  waitMs: number
  maxTrackedResults: number
  maxStateChars: number
}

export interface SkillDisclosureConfig {
  enabled: boolean
  minSkills: number
  maxSkills: number
  waitMs: number
  alwaysVisible: string[]
}

export interface AdmissionConfig {
  enabled: boolean
  minChars: number
  judgeMinChars: number
  chunkChars: number
  maxChunks: number
  waitMs: number
  testLog: 'off' | 'rules' | 'judge'
  /** Replace runs that repeat text the model still sees with a reference. Lossless while the source stays. */
  dedup: boolean
  /** Fold runs of lines that differ at most in numbers. */
  foldSimilar: boolean
  minNetChars: number
  minNetShare: number
  /** Tools whose output is never touched. */
  passThrough: string[]
  /** Tools whose output is file content: only `dedup` applies, nothing lossy. */
  contentTools: string[]
}

export const Config: z<Config> = z.object({
  judge: z.object({
    type: z.union(['auto', 'system-one', 'laya'] as const).default('auto'),
    model: z.string(),
    baseUrl: z.string(),
    apiKey: z.string(),
    timeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(4000),
  }).default({}),
  modes: z.dict(z.union(DECISION_MODES)).default({}),
  recordState: z.boolean().default(false),
  admission: z.object({
    enabled: z.boolean().default(true),
    minChars: z.natural().min(1).default(1500),
    judgeMinChars: z.natural().min(1).default(8000),
    chunkChars: z.natural().min(1).default(1200),
    maxChunks: z.natural().min(3).max(48).default(48),
    waitMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS),
    testLog: z.union(['off', 'rules', 'judge'] as const).default('rules'),
    dedup: z.boolean().default(true),
    foldSimilar: z.boolean().default(true),
    minNetChars: z.natural().min(1).default(300),
    minNetShare: z.number().min(0).max(1).default(0.1),
    passThrough: z.array(z.string()).default(['read_image', 'subagent', 'delegate']),
    contentTools: z.array(z.string()).default(['read', 'edit', 'write', 'str_replace_editor']),
  }).default({}),
  forgetting: z.object({
    enabled: z.boolean().default(true),
    keepRecent: z.natural().min(1).default(4),
    minChars: z.natural().min(1).default(1500),
    minBatchChars: z.natural().min(1).default(10_000),
    edgeChars: z.natural().default(300),
    maxPerBatch: z.natural().min(1).max(128).default(64),
    waitMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS),
    maxTrackedResults: z.natural().min(1).max(1024).default(128),
    maxStateChars: z.natural().min(1).default(2_000_000),
  }).default({}),
  skillDisclosure: z.object({
    enabled: z.boolean().default(true),
    minSkills: z.natural().min(1).default(3),
    maxSkills: z.natural().min(1).max(256).default(256),
    waitMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS),
    alwaysVisible: z.array(z.string()).default([]),
  }).default({}),
})

export type ResolvedJudge =
  | {
    /** Jev with the credential store's key, resolved per call. */
    readonly type: 'auto'
    readonly timeoutMs: number
  }
  | {
    readonly type: 'system-one'
    readonly apiKey: string
    readonly baseUrl: string | undefined
    readonly model: string | undefined
    readonly timeoutMs: number
  }
  | {
    readonly type: 'laya'
    readonly baseUrl: string | undefined
    readonly timeoutMs: number
  }

export interface ResolvedConfig {
  readonly judge: ResolvedJudge
  readonly defaultMode: DecisionMode
  readonly modes: ReadonlyMap<DecisionId, DecisionMode>
  readonly recordState: boolean
  readonly admission: Readonly<Omit<AdmissionConfig, 'passThrough' | 'contentTools'>> & { readonly passThrough: readonly string[], readonly contentTools: readonly string[] }
  readonly forgetting: Readonly<ForgettingConfig>
  readonly skillDisclosure: Readonly<Omit<SkillDisclosureConfig, 'alwaysVisible'>> & { readonly alwaysVisible: readonly string[] }
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
  // The schema drops unknown keys; a profile written for the removed session-model judge must not load as if it worked.
  const raw = (config ?? {}) as Record<string, unknown>
  const rawJudge = typeof raw['judge'] === 'object' && raw['judge'] !== null ? raw['judge'] as Record<string, unknown> : {}
  if (rawJudge['type'] === 'llm' || rawJudge['type'] === 'off' || 'routes' in raw || 'provider' in rawJudge || 'maxOutputTokens' in rawJudge) {
    throw new Error('sieve: the session-model judge was removed (judge.type llm or off, judge.provider, judge.maxOutputTokens, routes); configure Jev or Laya')
  }

  const value = Config((config ?? {}) as Config)
  const judge = value.judge

  let resolved: ResolvedJudge
  if (judge.type === 'auto') {
    resolved = { type: 'auto', timeoutMs: judge.timeoutMs }
  } else if (judge.type === 'laya') {
    resolved = { type: 'laya', baseUrl: nonEmpty(judge.baseUrl), timeoutMs: judge.timeoutMs }
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
  if ('thresholds' in value.forgetting || 'minAgeTurns' in value.forgetting) {
    throw new Error('sieve: forgetting.thresholds and minAgeTurns were replaced by keepRecent and minBatchChars')
  }
  if (value.skillDisclosure.maxSkills < value.skillDisclosure.minSkills) throw new Error('sieve: skillDisclosure.maxSkills must be at least minSkills')
  for (const [key, mode] of Object.entries(value.modes)) {
    if (!MODE_KEYS.has(key)) {
      throw new Error(`sieve: unknown decision "${key}" in modes; known: default, ${DECISION_IDS.join(', ')}`)
    }
    if (key !== 'default') modes.set(key as DecisionId, mode)
  }

  return Object.freeze({
    judge: Object.freeze(resolved),
    // Active unless the profile says otherwise (user decision, 2026-10-06).
    defaultMode: value.modes['default'] ?? 'active',
    modes,
    recordState: value.recordState,
    admission: Object.freeze({
      ...value.admission,
      waitMs: value.admission.waitMs ?? Math.min(MAX_TIMER_DELAY_MS, judge.timeoutMs + 1000),
      passThrough: Object.freeze([...value.admission.passThrough]),
      contentTools: Object.freeze([...value.admission.contentTools]),
    }),
    forgetting: Object.freeze({ ...value.forgetting, waitMs: value.forgetting.waitMs ?? Math.min(MAX_TIMER_DELAY_MS, judge.timeoutMs + 1000) }),
    skillDisclosure: Object.freeze({ ...value.skillDisclosure, waitMs: value.skillDisclosure.waitMs ?? judge.timeoutMs, alwaysVisible: Object.freeze([...value.skillDisclosure.alwaysVisible]) }),
  })
}
