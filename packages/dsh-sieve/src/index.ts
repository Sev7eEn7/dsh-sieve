/**
 * dsh-sieve: token-saving judgment plugins for DeepSeek Harness.
 *
 * The `sieve` service binds the judgment kernel to profile configuration, a
 * dedicated judge model (Jev or Laya; never the session's own model) and the
 * durable ledger. Without a judge model it changes nothing. The MVP admits tool
 * output through bounded post-execute judgments and archived originals;
 * history forgetting and task-based skill catalogs use native session events.
 *
 * sieve must not append its own Session event types: at the pinned DSH version
 * a stored log containing an unknown event without the `ignorable` envelope
 * marker refuses to resume, and `Session.append` cannot set that marker
 * (tests/contracts/plugin-event-restore.spec.ts). State is derived from native
 * events or kept in `ctx.storage`.
 * @module dsh-sieve
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { DecisionMode } from './judge/decision.ts'
import { DecisionEngine } from './judge/engine.ts'
import { Inflight } from './judge/inflight.ts'
import { Judge } from './judge/judge.ts'
import type { JudgeLike } from './judge/judge.ts'
import type { LedgerAnnotation, LedgerRecord } from './judge/ledger.ts'
import { LayaJudgeProvider } from './judge/providers/laya.ts'
import { SystemOneJudgeProvider } from './judge/providers/system-one.ts'
import { environmentSecrets } from './judge/redact.ts'
import { Config, resolveConfig } from './runtime/config.ts'
import type { DecisionId, ResolvedConfig } from './runtime/config.ts'
import { SessionLedgers, ledgerDomain } from './runtime/ledger.ts'
import { JEV_BASE_URLS, StoredJevJudge, describeJevKeys, resolveJevKey, storeJevKey } from './runtime/jev.ts'
import type { JevKey } from './runtime/jev.ts'
import { registerAdmission } from './features/admission.ts'
import { registerForgetting } from './features/forgetting.ts'
import { registerSkills } from './features/skills.ts'
import { SessionRuntime, STATE_KEY } from './runtime/session-state.ts'
import { DEFAULT_RECENT_RECORDS, buildStatus } from './runtime/status.ts'
import type { JevService, SieveJudgeStatus, SieveStatus } from './status.ts'
import { registerSieveCommand } from './commands/sieve.ts'

export * as judge from './judge/index.ts'
export { Config, DECISION_IDS, resolveConfig } from './runtime/config.ts'
export type { DecisionId, JudgeConfig, JudgeType, ResolvedConfig, ResolvedJudge } from './runtime/config.ts'
export { LEDGER_SESSION_CAP, ledgerDomain } from './runtime/ledger.ts'
export { DEFAULT_RECENT_RECORDS, MAX_RECENT_RECORDS } from './runtime/status.ts'
export { JEV_BASE_URLS, JEV_KEY_REFS, JEV_SERVICES, JevKeyError } from './runtime/jev.ts'
export { DSH_TEXT_CHARS_PER_TOKEN } from './status.ts'
export type * from './status.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sieve: Sieve
  }
}

/** One session's view of sieve: the key of its ledger. */
export interface SessionScope {
  readonly sessionId: SessionId
}

/** How long unloading waits past the judge deadline for calls that ignore their abort. */
const SETTLE_MARGIN_MS = 1000

export class Sieve extends Service {
  static Config = Config

  readonly config: ResolvedConfig
  private ledgers: SessionLedgers | undefined
  /** Runtime mode overrides per session; a session without any has no entry. */
  private readonly overrides = new Map<SessionId, Map<DecisionId, DecisionMode>>()
  private readonly revisions = new Map<SessionId, number>()
  private readonly lifetime = new AbortController()
  /** Every decision and provider call still running, so unloading can wait for them. */
  private readonly inflight = new Inflight()
  /** The judge of a `system-one` or `laya` profile; `auto` builds one per call from the stored key. */
  private readonly configured: JudgeLike | undefined
  /** Jev keys resolved from the credential store, so judged states never carry them. */
  private readonly jevSecrets = new Set<string>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sieve')
    this.config = resolveConfig(config)
    const live = new Map<SessionId, Set<Agent>>()
    const remember = (agent: Agent): void => {
      const id = agent.session.header.id
      const agents = live.get(id) ?? new Set<Agent>()
      agents.add(agent)
      live.set(id, agents)
    }
    for (const agent of ctx.get('agents')?.list() ?? []) remember(agent)
    ctx.on('agent/created', ({ agent }) => { remember(agent); return undefined })
    ctx.on('agent/disposed', ({ agent }) => {
      const id = agent.session.header.id
      const agents = live.get(id)
      agents?.delete(agent)
      if (agents === undefined || agents.size === 0) {
        live.delete(id)
        this.overrides.delete(id)
        this.revisions.delete(id)
      }
    })
    const judge = this.config.judge
    this.configured = judge.type === 'auto'
      ? undefined
      : new Judge({
        provider: judge.type === 'laya'
          ? new LayaJudgeProvider({ baseUrl: judge.baseUrl })
          : new SystemOneJudgeProvider({ apiKey: judge.apiKey, baseUrl: judge.baseUrl, model: judge.model }),
        timeoutMs: judge.timeoutMs,
        inflight: this.inflight,
      })

    // Unloading aborts in-flight judge calls (their decisions fall back) and waits for them to stop.
    // Cordis runs disposers concurrently, so the ledger's disposer below waits for the same calls.
    ctx.effect(() => () => {
      this.lifetime.abort(new Error('sieve unloaded'))
      return this.settle()
    }, 'sieve.lifetime')

    // The ledger needs the storage domain facility (mounted by dsh-base). Without it
    // sieve still decides; nothing is recorded.
    ctx.plugin({
      name: 'sieve-ledger',
      inject: ['storageDomain'],
      apply: async (child: Context) => {
        const domain = await child.storageDomain.open(ledgerDomain)
        const ledgers = new SessionLedgers(domain.table('sessions'), child.logger)
        this.ledgers = ledgers
        child.effect(() => async () => {
          // Decisions still running record before the ledger closes, whether sieve or only storage unloads.
          await this.settle()
          if (this.ledgers === ledgers) this.ledgers = undefined
          await ledgers.drain()
          await domain.close()
        }, 'sieve.ledger')
      },
    })
    ctx.plugin({
      name: 'sieve-runtime',
      inject: ['sessionProjections'],
      apply: (child: Context) => {
        const runtime = new SessionRuntime(child, agent => this.engineFor(agent))
        child.plugin({ name: 'sieve-admission', inject: ['tools', 'spillStore'], apply: (feature: Context) => { registerAdmission(feature, this, runtime) } })
        child.plugin({ name: 'sieve-forgetting', inject: ['spillStore'], apply: (feature: Context) => { registerForgetting(feature, this, runtime) } })
        child.plugin({ name: 'sieve-skills', inject: ['skills'], apply: (feature: Context) => { registerSkills(feature, this, runtime) } })
      },
    })
    ctx.plugin({
      name: 'sieve-command',
      inject: ['commands'],
      apply: (child: Context) => { registerSieveCommand(child, this) },
    })
  }

  /**
   * The mode a decision runs in: the session's runtime override, the profile's
   * entry, or the profile default. Without a session, the profile's.
   */
  modeOf(specId: string, sessionId?: SessionId): DecisionMode {
    const id = specId as DecisionId
    const override = sessionId === undefined ? undefined : this.overrides.get(sessionId)?.get(id)
    return override ?? this.config.modes.get(id) ?? this.config.defaultMode
  }

  /** Override a decision's mode in one session until the service unloads; undefined returns it to the profile. */
  setMode(sessionId: SessionId, specId: DecisionId, mode: DecisionMode | undefined): void {
    this.revisions.set(sessionId, this.revisionOf(sessionId) + 1)
    const session = this.overrides.get(sessionId)
    if (mode !== undefined) {
      if (session === undefined) this.overrides.set(sessionId, new Map([[specId, mode]]))
      else session.set(specId, mode)
      return
    }
    session?.delete(specId)
    if (session?.size === 0) this.overrides.delete(sessionId)
  }

  revisionOf(sessionId: SessionId): number {
    return this.revisions.get(sessionId) ?? 0
  }

  /**
   * Whether a judge model is configured: Jev or Laya in the profile, or, for
   * `auto`, a Jev key in the credential store now. Without one sieve changes
   * nothing, rules included; the session model never stands in.
   */
  async judgeReady(): Promise<boolean> {
    return this.config.judge.type !== 'auto' || await this.resolveJev() !== undefined
  }

  track<T>(work: Promise<T>): Promise<T> {
    return this.inflight.track(work)
  }

  /** Whether the ledger is mounted. */
  get recording(): boolean {
    return this.ledgers !== undefined
  }

  /**
   * One session's state as JSON: modes, ledger totals and its latest
   * records. Without a live agent the log marker count is unknown, and no
   * override can exist.
   */
  status(sessionId: SessionId, options: { readonly recent?: number } = {}): SieveStatus {
    const agent = this.ctx.get('agents')?.get(sessionId)
    const reducedResults = agent === undefined
      ? null
      : this.ctx.get('sessionProjections')?.stateOf(agent.session, STATE_KEY)?.reduced ?? 0
    return buildStatus({
      sessionId,
      live: agent !== undefined,
      config: this.config,
      recording: this.recording,
      records: this.ledger(sessionId),
      reducedResults,
      contextTokens: agent === undefined ? null : this.contextTokens(agent),
      modeOf: id => this.modeOf(id, sessionId),
      overridden: id => this.overrides.get(sessionId)?.has(id) ?? false,
      recent: options.recent ?? DEFAULT_RECENT_RECORDS,
    })
  }

  /** Which judge answers next, and which Jev keys the credential store holds (never their values). */
  async judgeStatus(): Promise<SieveJudgeStatus> {
    const judge = this.config.judge
    const keys = await describeJevKeys(this.ctx.get('credentials'))
    const stored = keys.find(key => key.configured)
    const using: SieveJudgeStatus['using'] = judge.type === 'laya'
      ? { kind: 'laya' }
      : judge.type === 'system-one'
        ? { kind: 'jev', service: judge.baseUrl === undefined ? 'typesafe' : judge.baseUrl === JEV_BASE_URLS.openrouter ? 'openrouter' : null }
        : stored !== undefined ? { kind: 'jev', service: stored.service } : { kind: 'none' }
    return { type: judge.type, using, keys }
  }

  /**
   * Store one service's Jev key in DSH's credential store, or remove it with
   * `undefined`. An `auto` judge reads it from the next call on.
   * @throws {JevKeyError} without a credential store, or for a key the process environment supplies.
   */
  async setJevKey(service: JevService, apiKey: string | undefined): Promise<void> {
    await storeJevKey(this.ctx.get('credentials'), service, apiKey)
    if (apiKey !== undefined) this.jevSecrets.add(apiKey)
  }

  /** A session's ledger records, oldest first; empty when the ledger is not mounted. */
  ledger(sessionId: SessionId): readonly LedgerRecord[] {
    return this.ledgers?.records(sessionId) ?? []
  }

  /**
   * Add what the host learned after a record was written; nothing when the
   * ledger is not mounted. Never rejects: a failed write is logged by the ledger.
   */
  async annotate(sessionId: SessionId, ledgerId: string, patch: LedgerAnnotation): Promise<void> {
    await this.ledgers?.annotate(sessionId, ledgerId, patch)
  }

  /** A decision engine for one session: the configured judge, the current modes, the session's ledger. */
  engine(scope: SessionScope): DecisionEngine {
    return new DecisionEngine({
      judge: () => this.judgeFor(),
      mode: specId => this.modeOf(specId, scope.sessionId),
      ledger: { append: record => this.ledgers?.append(scope.sessionId, record) },
      recordState: this.config.recordState,
      knownSecrets: () => this.knownSecrets(),
      signal: this.lifetime.signal,
      inflight: this.inflight,
    })
  }

  /** The same for an agent: its session's ledger. */
  engineFor(agent: Agent): DecisionEngine {
    return this.engine({ sessionId: agent.session.header.id })
  }

  private judgeFor(): JudgeLike {
    const judge = this.config.judge
    if (this.configured !== undefined) return this.configured
    return new StoredJevJudge({
      resolve: () => this.resolveJev(),
      jev: key => new Judge({
        provider: new SystemOneJudgeProvider({ apiKey: key.apiKey, baseUrl: JEV_BASE_URLS[key.service] }),
        timeoutMs: judge.timeoutMs,
        inflight: this.inflight,
      }),
    })
  }

  /** The stored Jev key for this call, if any; remembered for redaction. */
  private async resolveJev(): Promise<JevKey | undefined> {
    const key = await resolveJevKey(this.ctx.get('credentials'))
    if (key !== undefined) this.jevSecrets.add(key.apiKey)
    return key
  }

  /** Route-priced tokens of the agent's current request surface; null when it cannot be measured. */
  private contextTokens(agent: Agent): number | null {
    const meter = this.ctx.get('tokenMeter')
    if (meter === undefined) return null
    try {
      return meter.measure(agent.session).surfaceTokens
    } catch {
      // A status read must not fail because the session is mid-replay.
      return null
    }
  }

  /** Waits for running decisions and provider calls, bounded by the judge deadline plus a margin. */
  private async settle(): Promise<void> {
    const judge = this.config.judge
    const bound = judge.timeoutMs + SETTLE_MARGIN_MS
    if (await this.inflight.settle(bound)) return
    this.ctx.logger.warn(`sieve: ${this.inflight.size} judge call(s) still running ${bound} ms after unload began; no longer waiting`)
  }

  private knownSecrets(): readonly string[] {
    const judge = this.config.judge
    const secrets = [...environmentSecrets(), ...this.jevSecrets]
    return judge.type === 'system-one' ? [judge.apiKey, ...secrets] : secrets
  }
}

export default Sieve
