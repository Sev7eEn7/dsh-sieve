/**
 * One hive run: bees on one problem, each a DSH in-process child started by
 * `ctx.subagents.startActivation` under a reserved id, joined by a board only
 * the judge writes to (`src/judge/hive/`).
 *
 * Ported from mu `packages/kyrn-judge/src/extension/features/hive.ts`
 * (`registerHive`, `registerMember`) and `src/swarm/run.ts` (time budget,
 * grace and watchdog), rewritten for DSH: mu's bees are processes reading
 * environment variables and shared files; here they are child Agents whose
 * session events the runtime reads (`HiveRuntime` in ./index.ts), told what
 * the gates accepted at their step boundaries (`agent/pre-step`) and steered
 * for a last call or a wrap-up.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { SubagentActivation, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { DecisionEngine } from '../../judge/engine.ts'
import { pickModel, swarmRouting } from '../../judge/decisions/swarm-routing.ts'
import type { RoutingOutcome } from '../../judge/decisions/swarm-routing.ts'
import { Board, foldRelations, pairKey } from '../../judge/hive/board.ts'
import type { Note } from '../../judge/hive/board.ts'
import { CHECKPOINT, NOTES_HEADER, lastCall, toolsClosed, wrapUp } from '../../judge/hive/markers.ts'
import { HiveMember, candidatesOf, clip } from '../../judge/hive/member.ts'
import type { StepFacts } from '../../judge/hive/member.ts'
import { renderHiveReport, reportOf } from '../../judge/hive/report.ts'
import type { ModelRoute, ResolvedHiveConfig } from '../../runtime/config.ts'
import { hiveMessage } from '../../runtime/sources.ts'
import type { BeeStatus, HiveBeeRecord, HiveRunRecord } from './store.ts'

/** How long the last turn waits for the judge to finish with the notes that are still in flight. */
export const LAST_CALL_WAIT_MS = 4000
/** How long a finished bee waits for its last step's notes to reach the board. */
export const SETTLE_WAIT_MS = 6000
/** How often the watchdog looks. */
const WATCH_MS = 1000
/** Report text kept per bee in the stored record. */
const STORED_REPORT_CHARS = 20_000

/** The bee's placement: the route it runs on, as `swarm.routing` chose it, or the parent's. */
export interface Placement {
  readonly route: ModelRoute | undefined
  readonly thinking: RoutingOutcome['thinking'] | undefined
  readonly agentOptions: AgentOptions | undefined
  readonly label: string
}

export interface BeeRequest {
  readonly name: string
  readonly focus: string
}

export interface HiveHooks {
  /** Make a reserved child id known before its Agent exists. */
  enroll(bee: Bee): void
  /** Forget it once the run is over. */
  release(bee: Bee): void
  /** A run started, changed or ended: for the live view. */
  changed(run: HiveRun): void
}

export interface HiveRunOptions {
  readonly ctx: Context
  readonly parent: Agent
  readonly callId: string
  readonly goal: string
  readonly config: ResolvedHiveConfig
  readonly engine: DecisionEngine
  readonly hooks: HiveHooks
  readonly signal: AbortSignal
  readonly now?: (() => number) | undefined
}

function textOf(content: readonly ContentBlock[]): string {
  return content.map(block => block.type === 'text' ? block.text : '').join('')
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function isActivationLimit(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ACTIVATION_LIMIT_REACHED'
}

/** Names as given, trimmed, made unique with a numeric suffix. */
export function uniqueNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((raw) => {
    const name = raw.trim().replace(/\s+/g, '-') || 'bee'
    const count = (seen.get(name) ?? 0) + 1
    seen.set(name, count)
    return count === 1 ? name : `${name}-${count}`
  })
}

/** One bee: the child Agent's run state and its seat at the gates. */
export class Bee {
  readonly name: string
  readonly focus: string
  readonly childId: SessionId
  readonly member: HiveMember
  readonly placement: Placement
  readonly verifier: boolean
  readonly run: HiveRun
  agent: Agent | undefined
  activation: SubagentActivation | undefined
  status: BeeStatus = 'waiting'
  /** The text of its latest message, for the live view and as a report of last resort. */
  said = ''
  /** The messages it ended a turn with; the report is chosen from them. */
  readonly finals: string[] = []
  lastCalled = false
  /** Why its tools are closed, once they are. */
  closed: string | undefined
  closedAt: number | undefined
  silentCalls = 0
  private checkpointDue = false
  lastActivity: number
  inTool = 0
  startedAt: number | undefined
  endedAt: number | undefined
  error: string | undefined
  private step: { said: string, calls: StepFacts['calls'][number][], results: StepFacts['results'][number][] } | undefined

  constructor(run: HiveRun, request: BeeRequest, placement: Placement, verifier: boolean, member: HiveMember) {
    this.run = run
    this.name = request.name
    this.focus = request.focus
    this.childId = SessionId(randomUUID())
    this.placement = placement
    this.verifier = verifier
    this.member = member
    this.lastActivity = run.now()
  }

  get over(): boolean {
    return this.status === 'done' || this.status === 'failed' || this.status === 'timed-out' || this.status === 'stalled' || this.status === 'stopped' || this.status === 'not-started'
  }

  /** The Agent appeared (`agent/created`), before its first step. */
  attach(agent: Agent): void {
    this.agent = agent
    this.touch()
  }

  touch(): void {
    this.lastActivity = this.run.now()
  }

  /** One durable event of the bee's session. */
  observe(event: SessionEvent): void {
    this.touch()
    if (event.type === 'assistant/message') {
      const content = event.data.message.content
      const said = textOf(content).trim()
      const calls = content.flatMap(block => block.type === 'tool-call' ? [{ id: block.id as string, name: block.name, arguments: parseArguments(block.arguments) }] : [])
      if (said !== '') this.said = said
      if (calls.length === 0) {
        // The end of a turn: its report, or the answer to a last call. Its words can still be news.
        if (said !== '') this.finals.push(said)
        this.step = undefined
        this.member.enqueue(candidatesOf({ said, calls: [], results: [] }), this.run.signal)
        this.run.hooks.changed(this.run)
        return
      }
      this.step = { said, calls, results: [] }
    } else if (event.type === 'tool/call') {
      this.inTool++
    } else if (event.type === 'tool/result') {
      this.inTool = Math.max(0, this.inTool - 1)
      const step = this.step
      if (step === undefined) return
      const message = event.data.message
      const call = step.calls.find(entry => entry.id === message.toolCallId)
      step.results.push({ callId: message.toolCallId, toolName: call?.name ?? 'tool', text: textOf(message.content) })
      if (step.results.length >= step.calls.length) this.completeStep(step)
    }
  }

  /**
   * A working step is over. Its candidates go to the gates off the bee's
   * critical path; what they accept reaches the bee at a later step boundary
   * (`boundary`).
   */
  private completeStep(step: NonNullable<Bee['step']>): void {
    this.step = undefined
    const candidates = candidatesOf(step)
    void this.member.enqueue(candidates, this.run.signal)
    const spoke = candidates.some(candidate => candidate.source === 'said')
    this.silentCalls = spoke ? 0 : this.silentCalls + step.results.length
    const every = this.run.config.checkpointEvery
    if (every > 0 && this.silentCalls >= every) {
      this.silentCalls = 0
      this.checkpointDue = true
    }
    this.run.hooks.changed(this.run)
  }

  /**
   * At the start of each of its steps (`agent/pre-step`): what the gates
   * accepted for the bee so far, and a checkpoint when it is due, as one
   * message that enters the step and is logged with it. An idle bee is not
   * woken, and a bee told to wrap up hears nothing more.
   */
  boundary(): UserMessage | undefined {
    if (this.closed !== undefined) return undefined
    const told: string[] = []
    if (this.member.pending > 0) {
      const lines = this.member.takeInbox()
      if (lines.length > 0) told.push(`${NOTES_HEADER}\n${lines.join('\n')}`)
    }
    if (this.checkpointDue) {
      this.checkpointDue = false
      told.push(CHECKPOINT)
    }
    if (told.length === 0) return undefined
    this.run.hooks.changed(this.run)
    return hiveMessage(this.name, told.join('\n\n'), told.length === 1 && told[0] === CHECKPOINT ? 'hive checkpoint' : 'notes from the hive')
  }

  /**
   * The bee is about to end its turn: what it just wrote is its report. Late
   * notes get one deliberate hearing, never an open-ended one.
   */
  async lastCall(agent: Agent, signal: AbortSignal): Promise<void> {
    if (this.lastCalled || !this.run.config.lastCall || this.closed !== undefined) return
    await Promise.race([this.member.idle, delay(LAST_CALL_WAIT_MS, signal)])
    if (this.member.pending === 0 || signal.aborted) return
    const lines = this.member.takeInbox()
    if (lines.length === 0) return
    this.lastCalled = true
    agent.steer(hiveMessage(this.name, lastCall(lines), 'hive last call'))
  }

  /** Close its tools and ask for the report now. */
  wrapUp(reason: string): void {
    if (this.closed !== undefined || this.over) return
    this.closed = reason
    this.closedAt = this.run.now()
    this.status = 'wrapping-up'
    // A running bee hears it at its next step; one already writing its report needs nothing.
    if (this.agent?.status === 'running') this.agent.steer(hiveMessage(this.name, wrapUp(reason), 'hive wrap-up'))
    this.run.hooks.changed(this.run)
  }

  /** What a tool call of a closed bee gets back. */
  get closedReason(): string | undefined {
    return this.closed === undefined ? undefined : toolsClosed(this.closed)
  }

  report(): string {
    return reportOf(this.finals) || this.said
  }

  record(): HiveBeeRecord {
    return {
      name: this.name,
      focus: this.focus,
      childId: this.childId,
      placement: this.placement.label,
      status: this.status,
      verifier: this.verifier,
      said: this.over ? clip(this.report(), STORED_REPORT_CHARS) : clip(this.said, 400),
      startedAt: this.startedAt === undefined ? null : new Date(this.startedAt).toISOString(),
      endedAt: this.endedAt === undefined ? null : new Date(this.endedAt).toISOString(),
    }
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** A counting gate: at most `size` holders at once. */
class Gate {
  private free: number
  private readonly waiting: (() => void)[] = []

  constructor(size: number) {
    this.free = size
  }

  async enter(signal: AbortSignal): Promise<boolean> {
    if (this.free > 0) {
      this.free--
      return true
    }
    await new Promise<void>((resolve) => {
      const wake = (): void => {
        signal.removeEventListener('abort', cancel)
        resolve()
      }
      const cancel = (): void => {
        const at = this.waiting.indexOf(wake)
        if (at >= 0) this.waiting.splice(at, 1)
        resolve()
      }
      this.waiting.push(wake)
      signal.addEventListener('abort', cancel, { once: true })
    })
    return !signal.aborted
  }

  leave(): void {
    const next = this.waiting.shift()
    if (next !== undefined) next()
    else this.free++
  }
}

export class HiveRun {
  readonly id = randomUUID()
  readonly ctx: Context
  readonly parent: Agent
  readonly callId: string
  readonly goal: string
  readonly config: ResolvedHiveConfig
  readonly engine: DecisionEngine
  readonly hooks: HiveHooks
  readonly board: Board
  readonly bees: Bee[] = []
  readonly notes: string[] = []
  readonly startedAt: number
  endedAt: number | undefined
  status: HiveRunRecord['status'] = 'running'
  readonly now: () => number
  private readonly lifetime = new AbortController()
  private readonly gate: Gate
  private readonly running = new Set<Promise<void>>()
  /** Bees holding one of the host's child slots, and starts not answered yet: what a bee turned away at the cap waits for. */
  private holding = 0
  private starting = 0
  private readonly slotWaiters = new Set<() => void>()
  private readonly firstSeen = new Map<string, number>()
  private readonly verified = new Set<string>()
  private verifiers = 0
  private spawning = false

  constructor(options: HiveRunOptions) {
    this.ctx = options.ctx
    this.parent = options.parent
    this.callId = options.callId
    this.goal = options.goal
    this.config = options.config
    this.engine = options.engine
    this.hooks = options.hooks
    this.now = options.now ?? Date.now
    this.startedAt = this.now()
    this.board = new Board({ now: this.now, maxGateEntries: 500 })
    this.gate = new Gate(this.config.concurrency)
    const abort = (): void => this.lifetime.abort(options.signal.reason)
    if (options.signal.aborted) abort()
    else options.signal.addEventListener('abort', abort, { once: true })
  }

  /** Aborted when the hive is cancelled or stopped. */
  get signal(): AbortSignal {
    return this.lifetime.signal
  }

  private origin(bee: string): { hive: string, bee: string } {
    return { hive: this.id, bee }
  }

  private memberFor(name: string, focus: string): HiveMember {
    return new HiveMember(name, focus, {
      goal: clip(this.goal, 600),
      board: this.board,
      engine: this.engine,
      limits: this.config,
      broadcast: this.config.sharing === 'broadcast',
      origin: bee => this.origin(bee),
      now: this.now,
    })
  }

  /** Route each task onto the model ladder; without one, every bee runs on the parent's route. */
  private async place(tasks: readonly string[]): Promise<Placement[]> {
    const ladder = this.config.models
    const parent: Placement = { route: undefined, thinking: undefined, agentOptions: undefined, label: 'parent model' }
    if (ladder.length === 0) return tasks.map(() => parent)
    const verdicts = await this.engine.decideMany(swarmRouting, tasks.map(task => ({ task: clip(task, 600) })), {
      signal: this.signal,
      origin: { hive: this.id },
    })
    return verdicts.map((verdict) => {
      const routing = verdict.judged ?? verdict.outcome
      const route = pickModel(ladder.map(entry => `${entry.provider}/${entry.model}`), routing.strength)
      const chosen = ladder.find(entry => `${entry.provider}/${entry.model}` === route)
      if (chosen === undefined) return parent
      // A bee on the parent's own route keeps its reasoning effort: providers key the prompt cache on it.
      const sameRoute = this.parent.options.provider === chosen.provider && this.parent.options.model === chosen.model
      const effort = sameRoute ? undefined : this.config.efforts[routing.thinking]
      return {
        route: chosen,
        thinking: routing.thinking,
        agentOptions: { provider: chosen.provider, model: chosen.model, ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) } },
        label: `${chosen.provider}/${chosen.model}, thinking ${routing.thinking}`,
      }
    })
  }

  private instructions(bee: Bee): string {
    const others = this.bees.filter(other => other !== bee).map(other => `- ${other.name}: ${clip(other.focus, 300)}`)
    return [
      `You are "${bee.name}", one of ${this.bees.length} investigators working on the same problem at the same time.`,
      `The problem:\n${this.goal}`,
      `Your angle: ${bee.focus}`,
      ...others.length > 0 ? [`The others, so you do not repeat them:\n${others.join('\n')}`] : [],
      'You investigate and report; you change nothing. Do not edit, create or delete files, and do not run commands that write to the project or its environment (installs, builds that write outputs, commits, formatters). Your file-editing tools are disabled.',
      'What you find is passed to the others who need it, and what they find reaches you as notes between your steps. State findings plainly as you go, with the file and line or the command that shows them.',
      'When you are done, reply with your final report: what you established, what you ruled out, and what you would check next, with the files, lines or commands that show it.',
    ].join('\n\n')
  }

  /** Run the hive to the end and return the tool's text. */
  async execute(requests: readonly BeeRequest[]): Promise<string> {
    const asked = requests.slice(0, this.config.maxBees)
    if (requests.length > asked.length) this.notes.push(`${requests.length - asked.length} of the requested bees were dropped: at most ${this.config.maxBees} run at once.`)
    const names = uniqueNames(asked.map(bee => bee.name))
    const placements = await this.place(asked.map(bee => `${bee.focus} (part of: ${this.goal})`))
    asked.forEach((request, at) => {
      const name = names[at] ?? `bee-${at + 1}`
      this.bees.push(new Bee(this, { name, focus: request.focus }, placements[at] ?? placements[0]!, false, this.memberFor(name, request.focus)))
    })
    this.hooks.changed(this)
    const watch = setInterval(() => this.watch(), WATCH_MS)
    // The activation signal only cancels a start; a started bee is stopped by disposing it.
    const reclaim = (): void => {
      for (const bee of this.bees) void bee.activation?.dispose().catch(() => undefined)
    }
    this.signal.addEventListener('abort', reclaim, { once: true })
    try {
      for (const bee of this.bees) this.launch(bee)
      while (this.running.size > 0) await Promise.race(this.running)
    } finally {
      clearInterval(watch)
      this.signal.removeEventListener('abort', reclaim)
    }
    this.endedAt = this.now()
    this.status = this.signal.aborted ? 'cancelled' : 'done'
    this.hooks.changed(this)
    for (const bee of this.bees) this.hooks.release(bee)
    return this.render()
  }

  private launch(bee: Bee): void {
    const done = this.fly(bee).finally(() => { this.running.delete(done) })
    this.running.add(done)
  }

  /** Start one bee under the concurrency gate, wait for its report, and release it. */
  private async fly(bee: Bee): Promise<void> {
    if (!await this.gate.enter(this.signal)) {
      bee.status = 'stopped'
      return
    }
    let held = false
    try {
      const activation = await this.start(bee)
      if (activation === undefined) return
      held = true
      let result: SubagentResult | undefined
      try {
        result = await activation.result
      } catch (error) {
        bee.error = error instanceof Error ? error.message : String(error)
      }
      // The child is torn down once its result settles: its slot goes to a bee waiting for one.
      await activation.dispose().catch(() => undefined)
      held = false
      this.releaseSlot()
      // What it found at the end gets a moment to reach the board, for the others and for the report.
      await Promise.race([bee.member.idle, delay(SETTLE_WAIT_MS, this.signal)])
      bee.endedAt ??= this.now()
      if (result !== undefined) {
        const output = textOf(result.output).trim()
        if (bee.finals.length === 0 && output !== '') bee.finals.push(output)
        if (!bee.over) bee.status = result.stopReason === 'completed' ? 'done' : this.signal.aborted ? 'stopped' : 'failed'
        if (result.stopReason !== 'completed' && result.diagnostic !== undefined) bee.error ??= result.diagnostic
      } else if (!bee.over) bee.status = this.signal.aborted ? 'stopped' : 'failed'
    } finally {
      if (held) this.releaseSlot()
      this.gate.leave()
      this.hooks.changed(this)
    }
  }

  private releaseSlot(): void {
    this.holding--
    this.wakeWaiters()
  }

  private wakeWaiters(): void {
    for (const wake of [...this.slotWaiters]) wake()
  }

  /** Settles when a waiting bee should try again: a slot of this hive's was freed, nothing of its is left to free one, or the hive is cancelled. */
  private nextSlot(): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        this.slotWaiters.delete(wake)
        this.signal.removeEventListener('abort', wake)
        resolve()
      }
      this.slotWaiters.add(wake)
      if (this.signal.aborted) wake()
      else this.signal.addEventListener('abort', wake, { once: true })
    })
  }

  /**
   * Start the child. The host caps live children per root session
   * (`maxActiveSubagents`); a bee turned away at the cap waits while one of
   * this hive's own children may still free a slot (one that runs, or one
   * whose start is not answered yet), and is not started when none is left.
   */
  private async start(bee: Bee): Promise<SubagentActivation | undefined> {
    this.hooks.enroll(bee)
    for (;;) {
      // Stopped while it waited (`/hive kill`): it stays stopped.
      if (bee.over) return undefined
      if (this.signal.aborted) {
        bee.status = 'stopped'
        return undefined
      }
      bee.status = 'running'
      bee.startedAt = this.now()
      bee.lastActivity = bee.startedAt
      this.hooks.changed(this)
      let error: unknown
      this.starting++
      try {
        const activation = await this.ctx.subagents.startActivation({
          provider: 'spawn',
          label: `hive: ${bee.name}`,
          childId: bee.childId,
          request: {
            parent: this.parent,
            prompt: [{ type: 'text', text: this.instructions(bee) }],
            // The bee's own depth is the cap: it cannot delegate further.
            maxDepth: delegationDepthOf(this.parent) + 1,
            ...bee.placement.agentOptions === undefined ? {} : { agentOptions: bee.placement.agentOptions },
          },
          signal: this.signal,
          delivery: 'caller',
        })
        this.holding++
        bee.activation = activation
        return activation
      } catch (caught) {
        error = caught
      } finally {
        this.starting--
      }
      bee.startedAt = undefined
      if (isActivationLimit(error) && (this.holding > 0 || this.starting > 0)) {
        bee.status = 'waiting'
        this.hooks.changed(this)
        await this.nextSlot()
        continue
      }
      // Bees waiting on this start look again: nothing of this hive's is left to free a slot.
      if (this.holding === 0 && this.starting === 0) this.wakeWaiters()
      bee.status = 'not-started'
      bee.error = error instanceof Error ? error.message : String(error)
      bee.endedAt = this.now()
      if (isActivationLimit(error)) this.notes.push(`${bee.name} was not started: the host's subagent capacity is used up.`)
      return undefined
    }
  }

  /** Time budget, grace and stalls, as mu's swarm watches them. */
  watch(now = this.now()): void {
    for (const bee of this.bees) {
      if (bee.status !== 'running' && bee.status !== 'wrapping-up') continue
      if (bee.activation === undefined) continue
      const quiet = now - bee.lastActivity
      const inTool = bee.inTool > 0
      const limit = (inTool ? this.config.toolStallSeconds : this.config.stallSeconds) * 1000
      if (quiet >= limit) {
        this.stop(bee, 'stalled', `no sign of life from ${inTool ? 'its tool call' : 'the model'} for ${Math.round(quiet / 1000)}s`)
        continue
      }
      if (bee.closed !== undefined) {
        if (now - (bee.closedAt ?? now) >= this.config.graceSeconds * 1000) this.stop(bee, 'timed-out', `${bee.closed}; no report within ${this.config.graceSeconds}s`)
      } else if (this.config.beeMinutes > 0 && now - (bee.startedAt ?? now) >= this.config.beeMinutes * 60_000) {
        bee.wrapUp(`time budget of ${this.config.beeMinutes} min reached`)
      }
    }
    this.checkDisputes(now)
  }

  /** Stop one bee; what it reported so far is still handed back. */
  stop(bee: Bee, status: BeeStatus, reason: string): void {
    if (bee.over) return
    const waiting = bee.status === 'waiting'
    bee.status = status
    bee.error = reason
    bee.endedAt = this.now()
    void bee.activation?.dispose().catch(() => undefined)
    // A bee waiting for a slot stops waiting.
    if (waiting) this.wakeWaiters()
    this.hooks.changed(this)
  }

  /** Stop every bee, or the one named. Returns how many were stopped. */
  stopBees(name: string | undefined, reason: string): number {
    let stopped = 0
    for (const bee of this.bees) {
      if ((name === undefined || bee.name === name) && !bee.over) {
        this.stop(bee, 'stopped', reason)
        stopped++
      }
    }
    if (name === undefined) this.lifetime.abort(new Error(reason))
    return stopped
  }

  /** Wrap every bee up, or the one named. */
  wrapUpBees(name: string | undefined, reason: string): number {
    let told = 0
    for (const bee of this.bees) {
      if ((name === undefined || bee.name === name) && !bee.over && bee.closed === undefined) {
        bee.wrapUp(reason)
        told++
      }
    }
    return told
  }

  /**
   * A dispute nobody settles gets a verifier of its own while the hive still
   * runs: one more bee whose angle is the two notes. What it finds goes
   * through the same gates, so the losing side is corrected for everyone who
   * heard it. The judge never picks a side itself.
   */
  private checkDisputes(now: number): void {
    if (this.spawning || this.verifiers >= this.config.verifyConflicts || this.signal.aborted) return
    if (!this.bees.some(bee => bee.status === 'running')) return
    const notes = this.board.all()
    const state = foldRelations(notes, this.board.relations())
    const byId = new Map(notes.map(note => [note.id, note]))
    for (const rows of state.contested.values()) {
      for (const row of rows) {
        const key = pairKey(row.earlier, row.later)
        const since = this.firstSeen.get(key)
        if (since === undefined) {
          this.firstSeen.set(key, now)
          continue
        }
        if (this.verified.has(key) || now - since < this.config.verifyAfterSeconds * 1000) continue
        const a = byId.get(row.earlier)
        const b = byId.get(row.later)
        if (a === undefined || b === undefined) continue
        this.verified.add(key)
        void this.verify(a, b)
        return
      }
    }
  }

  private async verify(a: Note, b: Note): Promise<void> {
    this.spawning = true
    try {
      const wanted = `verify-${this.verifiers + 1}`
      const name = uniqueNames([...this.bees.map(bee => bee.name), wanted]).at(-1) ?? wanted
      const focus = `Two investigators disagree. ${a.bee} reported: "${clip(a.text, 400)}" ${b.bee} reported: "${clip(b.text, 400)}" Find out which holds, or that both do under different conditions, with the command, file and line that shows it, and state it as FOUND: in your report.`
      const [placement] = await this.place([`${focus} (part of: ${this.goal})`])
      if (this.signal.aborted || placement === undefined) return
      const bee = new Bee(this, { name, focus }, placement, true, this.memberFor(name, focus))
      this.bees.push(bee)
      this.verifiers++
      this.board.log({ gate: 'verify', bee: name, notes: [a.id, b.id] })
      this.launch(bee)
    } catch {
      // A verifier that could not be started leaves the dispute in the report, both sides kept.
    } finally {
      this.spawning = false
    }
  }

  render(): string {
    const reported = this.bees.map((bee) => {
      const report = bee.report()
      const ending = bee.status === 'done' ? '' : `\n(${bee.status}${bee.error === undefined ? '' : `: ${bee.error}`})`
      return { name: bee.name, placement: bee.placement.label, report: `${report === '' ? '(no report)' : report}${ending}` }
    })
    const footer = [
      ...this.notes,
      `(hive ${this.id}; the bees stay reachable with send_message until the session ends)`,
    ].join('\n')
    return renderHiveReport(reported, this.board.snapshot(), footer)
  }

  record(): HiveRunRecord {
    return {
      v: 1,
      id: this.id,
      sessionId: this.parent.session.header.id,
      callId: this.callId,
      goal: clip(this.goal, 2000),
      status: this.status,
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: this.endedAt === undefined ? null : new Date(this.endedAt).toISOString(),
      bees: this.bees.map(bee => bee.record()),
      board: this.board.snapshot(),
      notes: [...this.notes],
    }
  }
}
