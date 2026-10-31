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

/**
 * The registered decisions: the first release's four (migration plan §1) and
 * the harness modules' (docs/plan-harness-modules.md).
 */
export const DECISION_IDS = [
  'tool.admission', 'tool.admission.test-log', 'context.forget', 'skills.disclosure',
  'hive.publish', 'hive.deliver', 'hive.relate', 'swarm.routing',
  'goal.met', 'turn.completion', 'turn.drift',
  'turn.rewind', 'resume.safety',
  'tool.approval', 'tool.risk',
  'team.release', 'team.verify', 'team.conflict', 'team.dispatch',
] as const
export type DecisionId = typeof DECISION_IDS[number]

/**
 * Decisions that start in `shadow` until their ledger shows they judge well
 * (plan D5): they change what an agent does. A profile `default` can only
 * lower them (to `off`); a per-decision entry sets them outright.
 */
const SHADOW_BY_DEFAULT: ReadonlySet<DecisionId> = new Set<DecisionId>([
  'goal.met', 'turn.completion', 'turn.drift',
  'team.release', 'team.verify', 'team.conflict', 'team.dispatch',
])

const MODE_RANK: Readonly<Record<DecisionMode, number>> = { off: 0, shadow: 1, active: 2 }

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
  hive: HiveConfig
  monitor: MonitorConfig
  checkpoint: CheckpointConfig
  resume: ResumeConfig
  approval: ApprovalConfig
  team: TeamConfig
}

/**
 * The team supervisor (plan §4 phase 6). It loads only where DSH's agent team
 * is mounted, and its actions start in shadow (D5).
 */
export interface TeamConfig {
  enabled: boolean
  /** Monitor signals (loop, stall, drift) after which a member is interrupted and its tasks released. */
  stuckAfter: number
  /** Start a read-only verifier when `team.verify` cannot settle a completed task. */
  verifier: boolean
  /** Minutes a verifier may run before it is stopped and the task left as it is; 0 means no limit. */
  verifierMinutes: number
}

/**
 * Jev approval (plan §4 phase 3). Off by default (D2): a wrong approval cannot
 * be taken back, and owning DSH's single Auto preset excludes auto-review.
 * Turned on, it acts only in sessions the user switches to Auto.
 */
export interface ApprovalConfig {
  enabled: boolean
}

/** Crash-resume classification (plan §4 phase 5). */
export interface ResumeConfig {
  enabled: boolean
}

/** The hive (plan §4 phase 1); defaults are mu's. */
export interface HiveConfig {
  enabled: boolean
  maxBees: number
  /** Bees running at once; the rest wait for a slot. */
  concurrency: number
  maxNotesPerBee: number
  maxDeliveriesPerBee: number
  /** Earlier notes a new one is held against, at most. */
  maxRelatedPerNote: number
  /**
   * `judged`: the judge picks what is posted and who receives it. `broadcast`:
   * every step's candidates are posted and handed to every other bee, with no
   * judge and no corrections, still within the caps above; it exists for the
   * ablation against the judged hive.
   */
  sharing: 'judged' | 'broadcast'
  /** Tool calls a bee may make in silence before it is asked what it has found; 0 turns checkpoints off. */
  checkpointEvery: number
  /** Notes that arrive while a bee writes its report get one hearing: a corrected report, or "NO CHANGE". */
  lastCall: boolean
  /** Verifiers the hive may add for disputes nobody settles (0 turns it off), and how long a dispute may stand first. */
  verifyConflicts: number
  verifyAfterSeconds: number
  /** Minutes a bee may work before it is told to wrap up and its tools close; 0 means no budget. */
  beeMinutes: number
  /** Seconds it then has to hand in its report before it is stopped. */
  graceSeconds: number
  /** Seconds without a sign of life before a bee is stopped: while its model works, and while a tool runs. */
  stallSeconds: number
  toolStallSeconds: number
  /**
   * Model ladder from cheapest to strongest, each `provider/model` (the first
   * `/` separates them). Empty: every bee runs on the parent's model and
   * `swarm.routing` is not asked.
   */
  models: string[]
  /** The route's reasoning-effort id for each thinking level `swarm.routing` picks; unset levels keep the parent's. */
  efforts: { low?: string, medium?: string, high?: string }
}

/** Long-task monitoring (plan §4 phase 2); cadences are mu's. */
export interface MonitorConfig {
  enabled: boolean
  /** How long the end of a turn and `update_goal complete` wait for an active verdict; defaults to the judge deadline. */
  waitMs: number
  /** Tool results between two drift questions while a goal is active. */
  every: number
  /** Results in a row of the same call ending the same way that make a loop. */
  repeats: number
  /** Recent actions the drift question reads. */
  window: number
  /** Loops of `repeats` results in a row after which an active goal is blocked as stalled. */
  stallLoops: number
}

/** Checkpoints of the working tree and the judged rewind (plan §4 phase 4); limits are mu's. */
export interface CheckpointConfig {
  enabled: boolean
  /**
   * Where the shadow repositories live, one per project. The bundle sets
   * `dshHomePath('sieve', 'checkpoints')`; empty leaves checkpoints off.
   */
  root: string
  /** Snapshots kept per project, and for how long. */
  keep: number
  maxAgeDays: number
  /** Larger files stay out of snapshots and are never touched by a rewind. */
  maxFileMb: number
  /** A first snapshot past either limit is not taken, and the session goes without checkpoints. */
  maxFiles: number
  maxTotalMb: number
  /** gitignore-style patterns on top of the project's own and the built-in list. */
  ignore: string[]
  /** Deadline of one git command. */
  timeoutMs: number
  /** Ask `turn.rewind` when the agent goes in circles, and propose going back. */
  propose: boolean
  /** A shell command that fails this many times in one turn asks `turn.rewind`. */
  failures: number
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
  hive: z.object({
    enabled: z.boolean().default(true),
    maxBees: z.natural().min(2).max(16).default(6),
    concurrency: z.natural().min(1).max(16).default(4),
    maxNotesPerBee: z.natural().default(12),
    maxDeliveriesPerBee: z.natural().default(10),
    maxRelatedPerNote: z.natural().default(6),
    sharing: z.union(['judged', 'broadcast'] as const).default('judged'),
    checkpointEvery: z.natural().default(4),
    lastCall: z.boolean().default(true),
    verifyConflicts: z.natural().max(4).default(1),
    verifyAfterSeconds: z.natural().min(1).default(60),
    beeMinutes: z.natural().default(10),
    graceSeconds: z.natural().min(1).default(90),
    stallSeconds: z.natural().min(1).default(300),
    toolStallSeconds: z.natural().min(1).default(900),
    models: z.array(z.string()).default([]),
    efforts: z.object({ low: z.string(), medium: z.string(), high: z.string() }).default({}),
  }).default({}),
  monitor: z.object({
    enabled: z.boolean().default(true),
    waitMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS),
    every: z.natural().min(1).default(6),
    repeats: z.natural().min(2).default(3),
    window: z.natural().min(1).max(32).default(8),
    stallLoops: z.natural().min(2).default(2),
  }).default({}),
  checkpoint: z.object({
    enabled: z.boolean().default(true),
    root: z.string().default(''),
    keep: z.natural().min(1).default(50),
    maxAgeDays: z.natural().min(1).default(14),
    maxFileMb: z.number().min(0).default(5),
    maxFiles: z.natural().min(1).default(5000),
    maxTotalMb: z.number().min(0).default(200),
    ignore: z.array(z.string()).default([]),
    timeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
    propose: z.boolean().default(true),
    failures: z.natural().min(2).default(3),
  }).default({}),
  resume: z.object({
    enabled: z.boolean().default(true),
  }).default({}),
  approval: z.object({
    enabled: z.boolean().default(false),
  }).default({}),
  team: z.object({
    enabled: z.boolean().default(true),
    stuckAfter: z.natural().min(1).default(2),
    verifier: z.boolean().default(true),
    verifierMinutes: z.number().min(0).max(MAX_TIMER_DELAY_MS / 60_000).default(10),
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
  readonly hive: ResolvedHiveConfig
  readonly monitor: Readonly<MonitorConfig>
  readonly checkpoint: Readonly<Omit<CheckpointConfig, 'ignore'>> & { readonly ignore: readonly string[] }
  readonly resume: Readonly<ResumeConfig>
  readonly approval: Readonly<ApprovalConfig>
  readonly team: Readonly<TeamConfig>
}

export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

export type ResolvedHiveConfig = Readonly<Omit<HiveConfig, 'models' | 'efforts'>> & {
  readonly models: readonly ModelRoute[]
  readonly efforts: Readonly<HiveConfig['efforts']>
}

/** `provider/model`, split at the first `/`. */
export function parseModelRoute(entry: string): ModelRoute {
  const at = entry.indexOf('/')
  if (at <= 0 || at === entry.length - 1) throw new Error(`sieve: hive.models entry "${entry}" is not provider/model`)
  return { provider: entry.slice(0, at), model: entry.slice(at + 1) }
}

/** The mode a profile gives a decision: its own entry, else the default, which only lowers a shadow-by-default decision. */
export function profileModeOf(config: Pick<ResolvedConfig, 'modes' | 'defaultMode'>, id: DecisionId): DecisionMode {
  const own = config.modes.get(id)
  if (own !== undefined) return own
  if (!SHADOW_BY_DEFAULT.has(id)) return config.defaultMode
  return MODE_RANK[config.defaultMode] < MODE_RANK.shadow ? config.defaultMode : 'shadow'
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
    hive: Object.freeze({
      ...value.hive,
      models: Object.freeze(value.hive.models.map(parseModelRoute)),
      efforts: Object.freeze(Object.fromEntries(Object.entries(value.hive.efforts).filter(([, effort]) => nonEmpty(effort) !== undefined))),
    }),
    monitor: Object.freeze({ ...value.monitor, waitMs: value.monitor.waitMs ?? judge.timeoutMs }),
    checkpoint: Object.freeze({ ...value.checkpoint, ignore: Object.freeze([...value.checkpoint.ignore]) }),
    resume: Object.freeze({ ...value.resume }),
    approval: Object.freeze({ ...value.approval }),
    team: Object.freeze({ ...value.team }),
  })
}
