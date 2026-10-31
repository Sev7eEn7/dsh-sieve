/**
 * The hive: the `hive` tool, the `/hive` command, and the hooks that make a
 * bee of a child Agent. Bees are DSH in-process subagents under ids reserved
 * before they start, so the hooks know a bee from its first event:
 *
 * - `agent/created`: its file-editing and delegation tools are hidden and its
 *   session's sandbox mode set to read-only (bash writes are fenced only where
 *   a sandbox runner is active);
 * - `session/event`: each finished step goes to the gates (`HiveMember`);
 * - `agent/pre-step`: what the gates accepted for it enters its next step;
 * - `agent/turn-stopping`: the last call;
 * - `tools/pre-execute`: tools of a bee told to wrap up are closed;
 * - `agent/assistant-stream`: liveness, for the watchdog.
 *
 * Ported from mu `packages/kyrn-judge/src/extension/features/hive.ts`.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DecisionEngine } from '../../judge/engine.ts'
import { hiveRequest, parseHiveArgs } from '../../judge/hive/request.ts'
import { summarizeBoard } from '../../judge/hive/report.ts'
import { clip } from '../../judge/hive/member.ts'
import { FILE_WRITE_TOOLS } from '../../judge/monitor/mutating.ts'
import type { ResolvedConfig } from '../../runtime/config.ts'
import { Bee, HiveRun } from './run.ts'
import type { BeeRequest, HiveHooks } from './run.ts'
import { HiveStore, hiveDomain } from './store.ts'
import type { HiveRunRecord } from './store.ts'

export const HIVE_TOOL = 'hive'
/** Tools that start more agents or worktrees: a bee investigates alone. */
export const DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'spawn_teammate', 'create_worktree', HIVE_TOOL] as const
const BEE_DENIED: readonly string[] = [...FILE_WRITE_TOOLS, ...DELEGATION_TOOLS]
/** How often a running hive's record is written for the live view. */
const SAVE_EVERY_MS = 2000
const MIN_BEES = 2

export interface HiveHost {
  readonly config: ResolvedConfig
  engineFor(agent: Agent): DecisionEngine
}

const DESCRIPTION = [
  'Run several read-only investigators ("bees") on one problem at the same time, each from its own angle, and get back every report plus a board of their findings.',
  'Between their steps a judge model passes each bee only the others\' findings that bear on its angle, corrections to findings it was given, and disputes; bees spend nothing on sharing, and none is flooded with what the others saw.',
  'Use it for a question whose angles bear on each other (an intermittent failure: reproduce it, read the history, read the configuration). Not for a single lookup, and not for changes: bees cannot edit files.',
  'Findings on the board are marked confirmed, corrected or disputed; weigh them accordingly. Each bee stays reachable with send_message after the hive returns.',
].join(' ')

/** The bees of running hives, the runs themselves, and where finished runs are kept. */
export class HiveRuntime {
  private readonly bees = new Map<SessionId, Bee>()
  /** Every bee of this plugin's lifetime: a bee messaged after its hive resumes with its tools hidden again. */
  private readonly readOnly = new Set<SessionId>()
  private readonly live = new Map<string, HiveRun>()
  private readonly saves = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lifetime = new AbortController()
  private readonly running = new Set<Promise<unknown>>()
  store: HiveStore | undefined

  readonly hooks: HiveHooks = {
    enroll: (bee) => {
      this.bees.set(bee.childId, bee)
      this.readOnly.add(bee.childId)
    },
    release: (bee) => {
      if (this.bees.get(bee.childId) === bee) this.bees.delete(bee.childId)
    },
    changed: run => this.schedule(run),
  }

  get signal(): AbortSignal {
    return this.lifetime.signal
  }

  beeOf(agent: Agent): Bee | undefined {
    return this.bees.get(agent.session.header.id)
  }

  beeIn(sessionId: SessionId): Bee | undefined {
    return this.bees.get(sessionId)
  }

  /**
   * Whether the agent is a bee, of a hive of this process or of a stored run:
   * after a restart a bee messaged again is a child of the session that ran
   * its hive, and only the stored runs (the latest `HIVE_SESSION_CAP`) know it.
   */
  isBee(agent: Agent): boolean {
    const header = agent.session.header
    if (this.readOnly.has(header.id)) return true
    if (header.origin !== 'subagent' || header.parentSession === undefined) return false
    const stored = this.store?.runs(header.parentSession).some(run => run.bees.some(bee => bee.childId === header.id)) === true
    if (stored) this.readOnly.add(header.id)
    return stored
  }

  /** A session's running hives. */
  liveRuns(sessionId: SessionId): HiveRun[] {
    return [...this.live.values()].filter(run => run.parent.session.header.id === sessionId)
  }

  /** A session's hives, oldest first: the stored ones, with the running ones as they are now. */
  records(sessionId: SessionId): HiveRunRecord[] {
    const live = this.liveRuns(sessionId).map(run => run.record())
    const ids = new Set(live.map(run => run.id))
    return [...(this.store?.runs(sessionId) ?? []).filter(run => !ids.has(run.id)), ...live]
  }

  /** Run one hive to its end. */
  async run(run: HiveRun, bees: readonly BeeRequest[]): Promise<string> {
    this.live.set(run.id, run)
    const work = run.execute(bees)
    this.running.add(work)
    try {
      return await work
    } finally {
      this.running.delete(work)
      const timer = this.saves.get(run.id)
      if (timer !== undefined) clearTimeout(timer)
      this.saves.delete(run.id)
      await this.store?.save(run.record())
      this.live.delete(run.id)
    }
  }

  private schedule(run: HiveRun): void {
    if (this.store === undefined || this.saves.has(run.id) || run.status !== 'running') return
    this.saves.set(run.id, setTimeout(() => {
      this.saves.delete(run.id)
      if (this.live.has(run.id)) void this.store?.save(run.record())
    }, SAVE_EVERY_MS))
  }

  /** Unloading stops every hive and waits for its bees to stop. */
  async close(): Promise<void> {
    this.lifetime.abort(new Error('sieve unloaded'))
    for (const run of this.live.values()) run.stopBees(undefined, 'sieve unloaded')
    await Promise.allSettled(this.running)
    for (const timer of this.saves.values()) clearTimeout(timer)
    this.saves.clear()
  }
}

export function registerHive(ctx: Context, host: HiveHost, runtime: HiveRuntime): void {
  const config = host.config.hive
  ctx.effect(() => () => runtime.close(), 'sieve.hive')

  ctx.on('agent/created', ({ agent, source }) => {
    if (!runtime.isBee(agent)) return undefined
    runtime.beeOf(agent)?.attach(agent)
    // `restrict` accepts only names registered globally; anything else is denied by name in `tools/pre-execute`.
    const hidden = BEE_DENIED.filter(name => ctx.tools.get(name) !== undefined)
    if (hidden.length > 0) agent.ctx.tools.restrict({ deny: hidden })
    // The mode is a native session event: it holds when the bee is resumed later.
    if (source !== 'resume' && ctx.get('sandboxPolicy') !== undefined) setSandboxMode(agent.session, 'read-only')
    return undefined
  })

  ctx.on('session/event', (session, event) => {
    runtime.beeIn(session.header.id)?.observe(event)
  })

  ctx.on('agent/assistant-stream', ({ agent }) => {
    runtime.beeOf(agent)?.touch()
  })

  // Inbox delivery at the step boundary: `agent.inject` from a `session/event` observer would re-enter the session append.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const told = runtime.beeOf(agent)?.boundary()
    return told === undefined ? decision : { ...decision, messages: [...decision.messages, told] }
  })

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    await runtime.beeOf(agent)?.lastCall(agent, signal)
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent
    if (agent === undefined || !runtime.isBee(agent)) return next()
    if (BEE_DENIED.includes(exec.name)) return { kind: 'deny', reason: `${exec.name} is not available to a hive investigator: investigate and report, change nothing.` }
    const reason = runtime.beeOf(agent)?.closedReason
    if (reason !== undefined) return { kind: 'deny', reason }
    return next()
  }, { prepend: true })

  ctx.tools.register(defineTool({
    name: HIVE_TOOL,
    description: DESCRIPTION,
    parameters: {
      goal: {
        type: 'string',
        required: true,
        description: 'The problem, as the bees should read it: what is known, what a complete answer must contain.',
      },
      bees: {
        type: 'array',
        required: true,
        description: `${MIN_BEES} to ${config.maxBees} investigators, each with a different angle on the same problem.`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Short name after its angle, e.g. "repro" or "history".' },
            focus: { type: 'string', required: true, description: 'What this bee looks at and how, so that what it finds can confirm, correct or advance the others.' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hive: { type: 'string', required: true },
          status: { type: 'string', required: true },
          bees: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                childId: { type: 'string', required: true },
                status: { type: 'string', required: true },
                placement: { type: 'string', required: true },
              },
            },
          },
          report: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('hive requires an owning agent session')
      if (runtime.isBee(parent)) throw new Error('a bee cannot start a hive')
      const goal = args.goal.trim()
      if (goal === '') throw new Error('goal is empty')
      const bees = args.bees.map(bee => ({ name: bee.name, focus: bee.focus.trim() })).filter(bee => bee.focus !== '')
      if (bees.length < MIN_BEES) throw new Error(`a hive needs at least ${MIN_BEES} bees with a focus`)
      const run = new HiveRun({
        ctx,
        parent,
        callId: exec.callId,
        goal,
        config,
        engine: host.engineFor(parent),
        hooks: runtime.hooks,
        signal: AbortSignal.any([exec.signal, runtime.signal]),
      })
      const report = await runtime.run(run, bees)
      return {
        hive: run.id,
        status: run.status,
        bees: run.bees.map(bee => ({ name: bee.name, childId: bee.childId, status: bee.status, placement: bee.placement.label })),
        report,
      }
    },
  }))

  ctx.plugin({
    name: 'sieve-hive-store',
    inject: ['storageDomain'],
    apply: async (child: Context) => {
      const domain = await child.storageDomain.open(hiveDomain)
      const store = new HiveStore(domain.table('sessions'), child.logger)
      runtime.store = store
      child.effect(() => async () => {
        if (runtime.store === store) runtime.store = undefined
        await store.drain()
        await domain.close()
      }, 'sieve.hive-store')
    },
  })

  ctx.plugin({
    name: 'sieve-hive-command',
    inject: ['commands'],
    apply: (child: Context) => { registerHiveCommand(child, runtime) },
  })
}

const USAGE = '/hive <问题> | status | stop [蜂] | kill [蜂]'

function seconds(from: number, to: number): string {
  return `${Math.max(0, Math.round((to - from) / 1000))} 秒`
}

/** `/hive` for a person: start one by asking, or watch and control the running ones. */
export function hiveStatusText(runs: readonly HiveRun[]): string {
  if (runs.length === 0) return '当前会话没有正在运行的 hive。'
  return runs.map((run) => {
    const board = summarizeBoard(run.board.snapshot())
    return [
      `hive ${run.id}：运行 ${seconds(run.startedAt, run.now())}；目标：${clip(run.goal, 120)}`,
      ...run.bees.map(bee => `- ${bee.name}${bee.verifier ? '（核验）' : ''} [${bee.placement.label}]：${bee.status}${bee.said === '' ? '' : `；最近：${clip(bee.said, 120)}`}`),
      `看板：${board.notes} 条笔记，${board.deliveries} 次投递，${board.corrections} 次更正，${board.conflicts} 个争议；判断 ${board.judged} 次`,
    ].join('\n')
  }).join('\n\n')
}

export function registerHiveCommand(ctx: Context, runtime: HiveRuntime): void {
  ctx.commands.register({
    name: 'hive',
    description: '让几只只读的蜂并行调查一个问题；不带问题时显示或控制正在运行的 hive',
    input: { hint: USAGE },
    handler: ({ agent, rawInput, signal }): CommandResult => {
      signal.throwIfAborted()
      const args = parseHiveArgs(rawInput)
      if (args.kind === 'question') {
        agent.followup(createUserMessage({ content: [{ type: 'text', text: hiveRequest(args.question) }], source: { kind: 'user' } }))
        return { kind: 'success', text: '已让主模型发起 hive。' }
      }
      const runs = runtime.liveRuns(agent.session.header.id)
      if (args.kind === 'status') return { kind: 'success', text: hiveStatusText(runs) }
      if (runs.length === 0) return { kind: 'error', text: '当前会话没有正在运行的 hive。' }
      const count = runs.reduce((total, run) => total + (args.verb === 'kill'
        ? run.stopBees(args.name, 'stopped by the user')
        : run.wrapUpBees(args.name, 'the user asked for the reports now')), 0)
      if (count === 0) return { kind: 'error', text: args.name === undefined ? '没有可操作的蜂。' : `没有名为 ${args.name} 的运行中的蜂。` }
      return { kind: 'success', text: args.verb === 'kill' ? `已停止 ${count} 只蜂；它们已有的报告照常交回。` : `已让 ${count} 只蜂收尾：工具关闭，立即交报告。` }
    },
  })
}
