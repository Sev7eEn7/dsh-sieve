/**
 * dsh-sieve: token-saving judgment plugins for DeepSeek Harness, ported from mu.
 *
 * P1 provides the judgment kernel as the `sieve` service: profile
 * configuration, a decision engine per session bound to the configured judge
 * (`ctx.llm`, System One or none), and the ledger in `ctx.storage`. The
 * decision points that use it arrive with the MVP (tool output admission) and
 * P2 (see docs/OPUS-5.5-MIGRATION-PLAN.md).
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
import type {} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { DecisionMode } from './judge/decision.ts'
import { DecisionEngine } from './judge/engine.ts'
import { Judge } from './judge/judge.ts'
import type { JudgeLike } from './judge/judge.ts'
import type { LedgerRecord } from './judge/ledger.ts'
import { LlmJudgeProvider } from './judge/providers/llm.ts'
import { SystemOneJudgeProvider } from './judge/providers/system-one.ts'
import { environmentSecrets } from './judge/redact.ts'
import { Config, resolveConfig } from './runtime/config.ts'
import type { DecisionId, LlmRoute, ResolvedConfig } from './runtime/config.ts'
import { SessionLedgers, ledgerDomain } from './runtime/ledger.ts'
import { llmCompletion } from './runtime/llm-completion.ts'

export * as judge from './judge/index.ts'
export { Config, DECISION_IDS, resolveConfig } from './runtime/config.ts'
export type { DecisionId, JudgeConfig, JudgeType, LlmRoute, ResolvedConfig, ResolvedJudge } from './runtime/config.ts'
export { LEDGER_SESSION_CAP, ledgerDomain } from './runtime/ledger.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sieve: Sieve
  }
}

/** One session's view of sieve: the key of its ledger and, for an llm judge, its model route. */
export interface SessionScope {
  readonly sessionId: SessionId
  /** The session's current route; used when the judge config names none. */
  readonly route?: (() => LlmRoute | undefined) | undefined
}

/** The route an agent's next request goes to: the logged request header, else its options. */
export function agentRoute(agent: Agent): LlmRoute | undefined {
  const routed = agent.session.requestHeader()?.config
  const provider = routed?.provider ?? agent.options.provider
  const model = routed?.model ?? agent.options.model
  return provider === undefined || model === undefined ? undefined : { provider, model }
}

export class Sieve extends Service {
  static inject = ['llm']
  static Config = Config

  readonly config: ResolvedConfig
  private ledgers: SessionLedgers | undefined
  private readonly overrides = new Map<DecisionId, DecisionMode>()
  private readonly lifetime = new AbortController()
  private readonly systemOne: JudgeLike | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sieve')
    this.config = resolveConfig(config)
    const judge = this.config.judge
    this.systemOne = judge.type === 'system-one'
      ? new Judge({
        provider: new SystemOneJudgeProvider({ apiKey: judge.apiKey, baseUrl: judge.baseUrl, model: judge.model }),
        timeoutMs: judge.timeoutMs,
      })
      : undefined

    // In-flight judge calls stop with the service; their decisions fall back.
    ctx.effect(() => () => this.lifetime.abort(new Error('sieve unloaded')), 'sieve.lifetime')

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
          if (this.ledgers === ledgers) this.ledgers = undefined
          await ledgers.drain()
          await domain.close()
        }, 'sieve.ledger')
      },
    })
  }

  /** The mode a decision runs in: a runtime override, the profile's entry, or the profile default. */
  modeOf(specId: string): DecisionMode {
    const id = specId as DecisionId
    return this.overrides.get(id) ?? this.config.modes.get(id) ?? this.config.defaultMode
  }

  /** Override a decision's mode until the service unloads; undefined returns it to the profile. */
  setMode(specId: DecisionId, mode: DecisionMode | undefined): void {
    if (mode === undefined) this.overrides.delete(specId)
    else this.overrides.set(specId, mode)
  }

  /** Whether the ledger is mounted. */
  get recording(): boolean {
    return this.ledgers !== undefined
  }

  /** A session's ledger records, oldest first; empty when the ledger is not mounted. */
  ledger(sessionId: SessionId): readonly LedgerRecord[] {
    return this.ledgers?.records(sessionId) ?? []
  }

  /** Record whether the host acted on a judged decision. */
  async markApplied(sessionId: SessionId, ledgerId: string, applied: boolean): Promise<void> {
    await this.ledgers?.markApplied(sessionId, ledgerId, applied)
  }

  /** A decision engine for one session: the configured judge, the current modes, the session's ledger. */
  engine(scope: SessionScope): DecisionEngine {
    return new DecisionEngine({
      judge: this.judgeFor(scope),
      mode: specId => this.modeOf(specId),
      ledger: { append: record => this.ledgers?.append(scope.sessionId, record) },
      recordState: this.config.recordState,
      knownSecrets: () => this.knownSecrets(),
      signal: this.lifetime.signal,
    })
  }

  /** The same for an agent: its session's ledger, and its own route when the config names none. */
  engineFor(agent: Agent): DecisionEngine {
    return this.engine({ sessionId: agent.session.header.id, route: () => agentRoute(agent) })
  }

  private judgeFor(scope: SessionScope): JudgeLike | undefined {
    const judge = this.config.judge
    if (judge.type === 'off') return undefined
    if (judge.type === 'system-one') return this.systemOne
    const configured = judge.route
    const complete = llmCompletion(this.ctx, {
      route: () => configured ?? scope.route?.(),
      maxTokens: judge.maxOutputTokens,
      sessionId: scope.sessionId,
    })
    return new Judge({ provider: new LlmJudgeProvider({ id: 'llm', complete }), timeoutMs: judge.timeoutMs })
  }

  private knownSecrets(): readonly string[] {
    const judge = this.config.judge
    const secrets = environmentSecrets()
    return judge.type === 'system-one' ? [judge.apiKey, ...secrets] : secrets
  }
}

export default Sieve
