/**
 * Checkpoints of the working tree, and a rewind the judge may propose.
 *
 * Before the first tool call of a turn that can change files, the project is
 * snapshotted into its shadow repository (`runtime/checkpoint/store.ts`) and
 * the snapshot is noted in the `sieve_checkpoints` index with the seq the
 * turn began after. `/sieve rewind` puts the files back (after a snapshot of
 * the present, so `/sieve rewind undo` can take it back) and forks the
 * conversation into a new session at that seq (D3). When the monitor sees the
 * agent go in circles, or one shell command keeps failing, `turn.rewind` asks
 * the judge whether this is a dead end; a confident yes adds one notice that
 * names the checkpoint. Nothing here rewinds on its own, and any failure
 * leaves DSH's plain behavior.
 *
 * A project goes without checkpoints where a snapshot would copy what is no
 * project: the home folder (or one that holds it), sieve's own folder, or a
 * first snapshot past `maxFiles` / `maxTotalMb`. A machine whose git cannot
 * run goes without them altogether. `/sieve checkpoints` and the status say
 * why.
 *
 * Ported from mu `packages/kyrn-judge/src/extension/features/checkpoint.ts`;
 * pi's tree navigation became a DSH fork, its dialogs became the words of
 * the command, and its writer-model lesson became a fixed notice.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * @module
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionLogOffset, SessionSeq, buildForkSeed } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { Decision } from '../../judge/engine.ts'
import { turnRewind } from '../../judge/decisions/turn-rewind.ts'
import type { RewindOutcome } from '../../judge/decisions/turn-rewind.ts'
import { clip } from '../../judge/hive/member.ts'
import { isMutatingCall } from '../../judge/monitor/mutating.ts'
import type { Sieve } from '../../index.ts'
import { GitMissing, GitUnusable, UNUSABLE_TEXT, spawnGit } from '../../runtime/checkpoint/git.ts'
import type { GitRun } from '../../runtime/checkpoint/git.ts'
import {
  BUILT_IN_IGNORES,
  SnapshotTooLarge,
  applyRestore,
  collectGarbage,
  diff,
  hasCommit,
  isWithin,
  openStore,
  planRestore,
  prune,
  releaseLocks,
  scan,
  snapshot,
  sweepProjects,
} from '../../runtime/checkpoint/store.ts'
import type { RestorePlan, RestoreResult, ScanLimits, Store } from '../../runtime/checkpoint/store.ts'
import { untilAbort } from '../../runtime/operations.ts'
import type { SessionRuntime } from '../../runtime/session-state.ts'
import type {} from '../../runtime/signals.ts'
import { sieveNotice } from '../../runtime/sources.ts'
import type { SieveCheckpointStatus } from '../../status.ts'
import { CHECKPOINT_STATE_KEY, registerTurnFacts } from './facts.ts'
import type { TurnFacts } from './facts.ts'
import { CheckpointIndex, checkpointDomain } from './records.ts'
import type { CheckpointRecord, RewindRecord, RewindScope } from './records.ts'

/**
 * Why checkpoints are off. `no_root`: the profile names no folder for them.
 * The machine's git says `git_missing`, `xcode_license`,
 * `developer_tools_missing`; the folder says `home_folder` and `own_folder`;
 * the first snapshot says the size ones, and stops before it writes anything.
 */
export type CheckpointsOff =
  | 'no_root'
  | 'no_index'
  | 'git_missing'
  | 'xcode_license'
  | 'developer_tools_missing'
  | 'home_folder'
  | 'own_folder'
  | 'too_many_files'
  | 'too_many_bytes'
  | 'too_slow'

const MAX_LISTED = 12
/** How many times one turn asks `turn.rewind`. */
const MAX_ASKED = 2

export interface CheckpointDeps {
  /** How git is run. Tests stand in for a machine without git. */
  readonly run?: GitRun
  /** The user's home folder: no checkpoints of it or of what holds it. */
  readonly home?: string
}

interface Project {
  readonly root: string
  store: Promise<Store> | undefined
  /** One shadow command at a time: they share an index. */
  chain: Promise<unknown>
  busy: number
  /** Off for this folder, for the rest of the process. */
  off: CheckpointsOff | undefined
}

interface Pending {
  readonly message: ReturnType<typeof sieveNotice>
  readonly turn: number
  readonly ledgerId: string | undefined
}

interface Live {
  turn: number
  /** The snapshot of this turn, taken or being taken. */
  taking: Promise<CheckpointRecord | undefined> | undefined
  checkpoint: CheckpointRecord | undefined
  /** The monitor's latest word about this turn. */
  trouble: string | undefined
  /** The trigger last asked about, so one trigger is asked once. */
  askedAbout: string | undefined
  asked: number
  asking: boolean
  proposed: { readonly id: number, readonly trigger: string, readonly at: string } | undefined
  queue: Pending[]
}

const listed = (paths: readonly string[]): string =>
  paths.length <= MAX_LISTED ? paths.join(', ') : `${paths.slice(0, MAX_LISTED).join(', ')} 等 ${paths.length} 个`

/** What a rewind would do to the files, in words. Relative paths and counts only. */
export function describePlan(plan: RestorePlan, keep: ReadonlySet<string> = new Set()): string {
  const acting = (paths: readonly string[]) => paths.filter(path => !keep.has(path))
  const lines = [
    acting(plan.restore).length > 0 ? `改回 ${acting(plan.restore).length} 个：${listed(acting(plan.restore))}` : '',
    acting(plan.remove).length > 0 ? `删除之后新建的 ${acting(plan.remove).length} 个：${listed(acting(plan.remove))}` : '',
    acting(plan.bringBack).length > 0 ? `找回之后删掉的 ${acting(plan.bringBack).length} 个：${listed(acting(plan.bringBack))}` : '',
    keep.size > 0 ? `保留手动改过的 ${keep.size} 个：${listed([...keep])}` : '',
    plan.leftAlone.length > 0 ? `不动 ${plan.leftAlone.length} 个：${listed(plan.leftAlone.map(entry => `${entry.path}（${entry.why}）`))}` : '',
  ].filter(Boolean)
  return lines.length > 0 ? lines.join('\n') : '没有文件与检查点不同'
}

const describeResult = (result: RestoreResult): string =>
  `改回 ${result.restored.length} 个，删除 ${result.removed.length} 个，找回 ${result.broughtBack.length} 个${
    result.leftAlone.length > 0 ? `，未动 ${result.leftAlone.length} 个（${listed(result.leftAlone.map(entry => entry.path))}）` : ''}`

/** Why checkpoints are off, in one line for the user. */
export function offText(code: CheckpointsOff, limits: { readonly maxFiles: number, readonly maxTotalMb: number, readonly timeoutMs: number }): string {
  switch (code) {
    case 'no_root': return '检查点已关闭：配置里没有 checkpoint.root。'
    case 'no_index': return '检查点已关闭：DSH 没有挂载存储（storageDomain），无处记录检查点。'
    case 'git_missing': return '检查点已关闭：这台机器上找不到 git。'
    case 'xcode_license': return `检查点已关闭：${UNUSABLE_TEXT.xcode_license}。在终端用 sudo xcodebuild -license 同意后重启 DSH。`
    case 'developer_tools_missing': return `检查点已关闭：${UNUSABLE_TEXT.developer_tools_missing}。用 xcode-select --install 安装后重启 DSH。`
    case 'home_folder': return '这个文件夹是主目录或包含主目录，不拍检查点。在项目文件夹里启动会话才有检查点。'
    case 'own_folder': return '这个文件夹在 sieve 自己存检查点的目录里，不拍检查点。'
    case 'too_many_files': return `这个文件夹要拍的文件超过 ${limits.maxFiles} 个，不拍检查点；可以调高 checkpoint.maxFiles。`
    case 'too_many_bytes': return `这个文件夹要拍的文件超过 ${limits.maxTotalMb} MB，不拍检查点；可以调高 checkpoint.maxTotalMb。`
    case 'too_slow': return `列出这个文件夹的文件用了超过 ${Math.round(limits.timeoutMs / 1000)} 秒，不拍检查点。`
  }
}

/** A rewind's file half: the snapshot of the present taken first, and what changed. */
interface FilesRewound {
  readonly undo: string
  readonly result: RestoreResult
}

export interface RewindRequest {
  /** The checkpoint number; the latest when absent. */
  readonly id?: number
  readonly scope: RewindScope
  /** Rewind files changed after the agent's last change too; by default they are kept. */
  readonly force: boolean
  /** Say what would happen, change nothing. */
  readonly preview: boolean
}

export class CheckpointRuntime {
  private readonly ctx: Context
  private readonly host: Sieve
  private readonly runtime: SessionRuntime
  private readonly config: Sieve['config']['checkpoint']
  private readonly run: GitRun
  private readonly home: string
  private readonly limits: ScanLimits
  private readonly projects = new Map<string, Project>()
  private readonly lives = new WeakMap<Agent, Live>()
  private readonly lifetime = new AbortController()
  /** Scans after the agent's changes that have not finished. */
  private readonly noting = new Set<Promise<void>>()
  index: CheckpointIndex | undefined
  /** Off on this machine, for the rest of the process. */
  private machineOff: CheckpointsOff | undefined

  constructor(ctx: Context, host: Sieve, runtime: SessionRuntime, deps: CheckpointDeps = {}) {
    this.ctx = ctx
    this.host = host
    this.runtime = runtime
    this.config = host.config.checkpoint
    this.home = deps.home ?? homedir()
    this.run = deps.run ?? spawnGit('git', this.config.timeoutMs, this.lifetime.signal)
    this.limits = { maxFiles: this.config.maxFiles, maxBytes: this.config.maxTotalMb * 1024 * 1024 }
    if (this.config.root === '') this.machineOff = 'no_root'
  }

  /** Why the next snapshot of this folder would not be taken; undefined when it would. */
  offFor(root: string): CheckpointsOff | undefined {
    if (this.machineOff !== undefined) return this.machineOff
    if (this.index === undefined) return 'no_index'
    const project = this.projects.get(root)
    if (project?.off !== undefined) return project.off
    if (isWithin(root, this.home)) return 'home_folder'
    return isWithin(this.config.root, root) ? 'own_folder' : undefined
  }

  /** The folder a session's tools work in now; undefined for a session without a project. */
  rootOf(agent: Agent): string | undefined {
    return this.ctx.get('workingDirectory')?.get(agent.session) ?? agent.session.header.cwd
  }

  live(agent: Agent): Live {
    let state = this.lives.get(agent)
    if (state === undefined) {
      state = { turn: -1, taking: undefined, checkpoint: undefined, trouble: undefined, askedAbout: undefined, asked: 0, asking: false, proposed: undefined, queue: [] }
      this.lives.set(agent, state)
    }
    return state
  }

  factsOf(agent: Agent): TurnFacts | undefined {
    return this.ctx.sessionProjections.stateOf(agent.session, CHECKPOINT_STATE_KEY)
  }

  /** This turn's state, reset when a new turn began. */
  turnOf(agent: Agent, facts: TurnFacts): Live {
    const state = this.live(agent)
    if (state.turn !== facts.turn) {
      state.turn = facts.turn
      state.taking = undefined
      state.checkpoint = undefined
      state.trouble = undefined
      state.askedAbout = undefined
      state.asked = 0
    }
    return state
  }

  /** The turn's snapshot, taken before its first change; a turn that only reads costs nothing. */
  async ensure(agent: Agent): Promise<CheckpointRecord | undefined> {
    const facts = this.factsOf(agent)
    if (facts === undefined || facts.startSeq < 0) return undefined
    const state = this.turnOf(agent, facts)
    state.taking ??= this.take(agent, facts).then((record) => {
      if (state.turn === facts.turn) state.checkpoint = record
      return record
    })
    return state.taking
  }

  private async take(agent: Agent, facts: TurnFacts): Promise<CheckpointRecord | undefined> {
    const root = this.rootOf(agent)
    if (root === undefined || this.offFor(root) !== undefined) return undefined
    const index = this.index
    if (index === undefined) return undefined
    const project = this.project(root)
    const sessionId = agent.session.header.id
    try {
      const store = await this.open(project)
      const id = index.nextId(sessionId)
      const taken = await this.exclusive(project, () => snapshot(store, `${sessionId}/${id}`, this.limits))
      const record: CheckpointRecord = {
        id,
        turn: facts.turn,
        boundarySeq: facts.startSeq - 1,
        commit: taken.commit,
        root,
        label: facts.label,
        at: new Date().toISOString(),
      }
      await index.addCheckpoint(sessionId, record)
      void index.setLastTree(sessionId, taken.tree)
      return record
    } catch (error) {
      this.giveUp(project, error)
      return undefined
    }
  }

  /** After a call that may have changed files: what the agent left is what a later hand edit differs from. */
  noteChange(agent: Agent): Promise<void> {
    const work = this.scanAfter(agent)
    this.noting.add(work)
    void work.finally(() => this.noting.delete(work))
    return work
  }

  /** Resolves once the scans and index writes started so far are done. */
  async idle(): Promise<void> {
    await Promise.all(this.noting)
    await Promise.all([...this.projects.values()].map(project => project.chain))
    await this.index?.drain()
  }

  private async scanAfter(agent: Agent): Promise<void> {
    const state = this.live(agent)
    const record = state.checkpoint
    const index = this.index
    if (record === undefined || index === undefined || this.offFor(record.root) !== undefined) return
    const project = this.project(record.root)
    try {
      const store = await this.open(project)
      const { tree } = await this.exclusive(project, () => scan(store, this.limits))
      await index.setLastTree(agent.session.header.id, tree)
    } catch (error) {
      this.giveUp(project, error)
    }
  }

  /** Checkpoints stop where git or the folder rules them out; the status says why. */
  private giveUp(project: Project, error: unknown): void {
    if (error instanceof GitMissing) this.machineOff ??= 'git_missing'
    else if (error instanceof GitUnusable) this.machineOff ??= error.reason
    else if (error instanceof SnapshotTooLarge) {
      const codes = { files: 'too_many_files', bytes: 'too_many_bytes', slow: 'too_slow' } as const
      project.off ??= codes[error.reason]
    } else {
      this.ctx.logger.warn(`sieve: no checkpoint for this turn (${clip(error instanceof Error ? error.message : String(error), 200)})`)
    }
  }

  private project(root: string): Project {
    let project = this.projects.get(root)
    if (project === undefined) {
      project = { root, store: undefined, chain: Promise.resolve(), busy: 0, off: undefined }
      this.projects.set(root, project)
    }
    return project
  }

  private exclusive<T>(project: Project, work: () => Promise<T>): Promise<T> {
    project.busy++
    const next = project.chain.then(work, work).finally(() => { project.busy-- })
    project.chain = next.catch(() => {})
    return next
  }

  private open(project: Project): Promise<Store> {
    project.store ??= this.exclusive(project, async () => {
      const store = await openStore({
        baseDir: this.config.root,
        root: project.root,
        run: this.run,
        maxFileBytes: this.config.maxFileMb * 1024 * 1024,
        ignore: [...BUILT_IN_IGNORES, ...this.config.ignore],
        ownFolders: [this.config.root],
      })
      // Old snapshots go when a project is first used; their objects follow in the background.
      const dropped = await prune(store, { keep: this.config.keep, maxAgeDays: this.config.maxAgeDays }).catch(() => 0)
      if (dropped > 0) void this.exclusive(project, () => collectGarbage(store)).catch(() => {})
      return store
    })
    const opening = project.store
    // A failed open is tried again next time.
    opening.catch(() => { if (project.store === opening) project.store = undefined })
    return opening
  }

  /** Repositories of projects nobody used for `maxAgeDays`, and of folders that are off limits now. */
  sweep(): void {
    if (this.config.root === '') return
    sweepProjects(this.config.root, this.config.maxAgeDays, Date.now(), root => isWithin(root, this.home) || isWithin(this.config.root, root))
  }

  /** Waits briefly for running git commands, then clears what they may have left locked. */
  async dispose(): Promise<void> {
    this.lifetime.abort(new Error('sieve checkpoints unloaded'))
    const wasBusy = [...this.projects.values()].some(project => project.busy > 0)
    await Promise.race([
      Promise.all([...this.projects.values()].map(project => project.chain)),
      new Promise((resolve) => { setTimeout(resolve, 3000).unref() }),
    ])
    for (const project of this.projects.values()) {
      const store = await project.store?.catch(() => undefined)
      if (store !== undefined) releaseLocks(store, wasBusy && project.busy > 0 ? 0 : 120_000)
    }
  }

  // --- the judged proposal -------------------------------------------------

  /** Why `turn.rewind` is asked now, if it is; `key` stays the same while the cause does. */
  private trigger(state: Live, facts: TurnFacts): { readonly key: string, readonly text: string } | undefined {
    if (state.trouble !== undefined) return { key: state.trouble, text: state.trouble }
    const failing = Object.entries(facts.failures).find(([, count]) => count >= this.config.failures)
    return failing === undefined ? undefined : { key: `failing: ${failing[0]}`, text: `the same failing command ran ${failing[1]} times: ${clip(failing[0], 120)}` }
  }

  /** At a step boundary: ask about a new trigger in the background, deliver a proposal that came in. */
  boundary(agent: Agent, turn: number): ReturnType<typeof sieveNotice>[] {
    const facts = this.factsOf(agent)
    if (facts === undefined) return []
    const state = this.turnOf(agent, facts)
    const mode = this.host.modeOf(turnRewind.id, agent.session.header.id)
    const cause = this.trigger(state, facts)
    const checkpoint = state.checkpoint
    if (this.config.propose && mode !== 'off' && cause !== undefined && checkpoint !== undefined
      && state.askedAbout !== cause.key && state.asked < MAX_ASKED && !state.asking) {
      const trigger = cause.text
      state.askedAbout = cause.key
      state.asked++
      state.asking = true
      const engine = this.runtime.for(agent)
      void engine.engine.decide(turnRewind, {
        goal: clip(this.ctx.get('goals')?.get(agent)?.objective ?? checkpoint.label, 600),
        recentSteps: facts.steps,
        trigger,
        editsSinceCheckpoint: facts.edits,
        ...(facts.lastCheckFailed === null ? {} : { lastCheckFailed: facts.lastCheckFailed }),
      }, { signal: engine.controller.signal, applied: false, origin: { turn, checkpoint: checkpoint.id } }).then((value: Decision<RewindOutcome>) => {
        if (value.source !== 'judge' || value.outcome !== 'propose' || mode !== 'active') return
        state.proposed = { id: checkpoint.id, trigger, at: new Date().toISOString() }
        state.queue.push({
          message: sieveNotice('rewind', `This approach looks like a dead end (${trigger}). Stop repeating it: tell the user what you tried and why it fails. They can put the files and the conversation back to checkpoint #${checkpoint.id}, before "${checkpoint.label}", with /sieve rewind ${checkpoint.id}.`, `dead end: ${clip(trigger, 120)}`),
          turn,
          ledgerId: value.ledgerId,
        })
        this.ctx.logger.info(`sieve: proposed going back to checkpoint #${checkpoint.id} in session ${agent.session.header.id} (${trigger})`)
      }).catch(() => {}).finally(() => { state.asking = false })
    }
    const due = state.queue.splice(0).filter(item => item.turn === turn)
    for (const item of due) {
      if (item.ledgerId !== undefined) void this.host.track(this.host.annotate(agent.session.header.id, item.ledgerId, { applied: true }))
    }
    return due.map(item => item.message)
  }

  /** A rewind's notice waiting for this session's next step, taken off the index. */
  takeNotice(agent: Agent): ReturnType<typeof sieveNotice> | undefined {
    const sessionId = agent.session.header.id
    const notice = this.index?.of(sessionId).notice
    if (notice === undefined || notice === null) return undefined
    void this.index?.setNotice(sessionId, null)
    return sieveNotice('rewind', notice.text, notice.summary)
  }

  // --- the commands --------------------------------------------------------

  private refusal(root: string): string | undefined {
    const off = this.offFor(root)
    if (off === undefined) return undefined
    // A folder that went over a size limit still opens the snapshots it already has.
    if (off === 'too_many_files' || off === 'too_many_bytes' || off === 'too_slow') return undefined
    return offText(off, this.config)
  }

  /** `/sieve checkpoints`: newest first, with how many files changed since each. */
  async listText(agent: Agent): Promise<string> {
    const sessionId = agent.session.header.id
    const records = [...(this.index?.of(sessionId).checkpoints ?? [])].reverse()
    const machine = this.machineOff ?? (this.index === undefined ? 'no_index' : undefined)
    if (machine !== undefined) return offText(machine, this.config)
    if (records.length === 0) {
      const root = this.rootOf(agent)
      const off = root === undefined ? undefined : this.offFor(root)
      return off === undefined ? '还没有检查点：每个回合第一次修改文件之前拍一个。' : offText(off, this.config)
    }
    const rows: string[] = []
    const trees = new Map<string, string>()
    for (const record of records.slice(0, 20)) {
      let changed: string
      try {
        const project = this.project(record.root)
        const store = await this.open(project)
        let tree = trees.get(record.root)
        if (tree === undefined) {
          tree = (await this.exclusive(project, () => scan(store))).tree
          trees.set(record.root, tree)
        }
        const now = tree
        changed = await hasCommit(store, record.commit)
          ? `之后改了 ${(await this.exclusive(project, () => diff(store, record.commit, now))).length} 个文件`
          : '快照已清理'
      } catch (error) {
        this.giveUp(this.project(record.root), error)
        changed = '无法读取'
      }
      rows.push(`#${record.id}  第 ${record.turn} 回合  ${record.at.slice(0, 19).replace('T', ' ')}  ${changed}  “${record.label}”`)
    }
    return `${rows.join('\n')}\n/sieve rewind [序号] [files|conversation|both] [preview|force] 回到某个检查点；/sieve rewind undo 撤销上一次回退。`
  }

  /** Files a rewind would change that somebody changed after the agent's last change: probably the user, by hand. */
  private async handEdited(store: Store, project: Project, plan: RestorePlan, nowTree: string, lastTree: string | null): Promise<string[]> {
    const planned = new Set([...plan.restore, ...plan.remove, ...plan.bringBack])
    // Without a record of the agent's last change nobody can tell, so every file counts as possibly the user's.
    if (lastTree === null) return [...planned]
    const since = await this.exclusive(project, () => diff(store, lastTree, nowTree)).catch(() => undefined)
    return since === undefined ? [...planned] : since.map(change => change.path).filter(path => planned.has(path))
  }

  /** `/sieve rewind`: the files, the conversation, or both, back to a checkpoint. */
  async rewind(agent: Agent, request: RewindRequest, signal: AbortSignal): Promise<{ ok: boolean, text: string }> {
    if (agent.status === 'running') return { ok: false, text: '代理还在运行。先停下它，再回退。' }
    const index = this.index
    if (index === undefined) return { ok: false, text: offText('no_index', this.config) }
    const sessionId = agent.session.header.id
    const own = index.of(sessionId)
    const checkpoint = request.id === undefined ? own.checkpoints.at(-1) : own.checkpoints.find(record => record.id === request.id)
    if (checkpoint === undefined) {
      return { ok: false, text: request.id === undefined ? '还没有检查点。' : `没有 #${request.id} 号检查点。/sieve checkpoints 列出全部。` }
    }
    // Without these the conversation cannot be forked: say so before any file is touched.
    if (request.scope !== 'files' && !request.preview && this.forkable(checkpoint)
      && (this.ctx.get('sessionQuery') === undefined || this.ctx.get('agents') === undefined)) {
      return { ok: false, text: 'DSH 没有挂载 sessionQuery 或 agents 服务，对话不能分叉；什么也没动。只回退文件用 /sieve rewind files。' }
    }
    const lines: string[] = []
    let files: FilesRewound | undefined
    if (request.scope !== 'conversation') {
      const refused = this.refusal(checkpoint.root)
      if (refused !== undefined) return { ok: false, text: refused }
      const project = this.project(checkpoint.root)
      const store = await this.open(project)
      if (!await hasCommit(store, checkpoint.commit)) return { ok: false, text: `#${checkpoint.id} 的快照已被清理。` }
      const now = await this.exclusive(project, () => scan(store))
      const plan = await this.exclusive(project, () => planRestore(store, checkpoint.commit, now.tree))
      const byHand = await this.handEdited(store, project, plan, now.tree, own.lastTree)
      const keep = new Set(request.force ? [] : byHand)
      signal.throwIfAborted()
      if (request.preview) {
        lines.push(`回到 #${checkpoint.id}（第 ${checkpoint.turn} 回合之前，“${checkpoint.label}”）时，文件会这样变：`, describePlan(plan, keep))
        if (keep.size > 0) lines.push('这些文件在代理最后一次修改之后又被改过（多半是手动），默认保留；加 force 一并回退，撤销快照可以找回。')
      } else {
        const undo = await this.exclusive(project, () => snapshot(store, `${sessionId}/undo-${Date.now()}`))
        const result = await this.exclusive(project, () => applyRestore(store, plan, keep))
        const after = await this.exclusive(project, () => scan(store))
        void index.setLastTree(sessionId, after.tree)
        files = { undo: undo.commit, result }
        lines.push(`文件已回到 #${checkpoint.id}：${describeResult(result)}。/sieve rewind undo 可以撤销。`)
      }
    }
    if (request.scope === 'files' || request.preview) {
      if (request.preview && request.scope !== 'files') lines.push(this.forkable(checkpoint) ? `对话会分叉成一个新会话，停在第 ${checkpoint.turn} 回合之前；原会话不变。` : '这个检查点在会话开头，对话不能再往前退。')
      if (files !== undefined) await this.filesRewound(sessionId, checkpoint, files)
      return { ok: true, text: lines.join('\n') }
    }
    if (!this.forkable(checkpoint)) {
      if (files !== undefined) await this.filesRewound(sessionId, checkpoint, files)
      return { ok: files !== undefined, text: [...lines, '这个检查点在会话开头，对话不能再往前退。'].join('\n') }
    }
    let forked: string
    try {
      forked = await this.fork(agent, checkpoint, signal)
    } catch (error) {
      const why = clip(error instanceof Error ? error.message : String(error), 200)
      if (files === undefined) return { ok: false, text: [...lines, `对话没能分叉（${why}），什么也没动。`].join('\n') }
      // The files went back already: the rewind stays one of the files, which undo can take back and this session is told about.
      await this.filesRewound(sessionId, checkpoint, files)
      return { ok: false, text: [...lines, `对话没能分叉（${why}）：只回退了文件，对话仍在这个会话里。`].join('\n') }
    }
    this.record(sessionId, checkpoint, request.scope, files?.undo ?? null, forked)
    // The new session starts with the checkpoints of the history it inherits, can undo this rewind, and is told what was abandoned.
    await index.seed(forked, {
      v: 1,
      checkpoints: own.checkpoints.filter(record => record.id <= checkpoint.id),
      rewinds: [rewindRecord(checkpoint, request.scope, files?.undo ?? null, forked)],
      lastTree: own.lastTree,
      notice: {
        text: [
          `The user went back to before "${checkpoint.label}". An attempt made after this point was abandoned${files === undefined ? '' : ' and its file changes were undone'}. Take a different approach.`,
          files === undefined ? 'The files were left as they are: they may still hold changes from the abandoned attempt.' : changedText(files.result),
        ].filter(Boolean).join('\n'),
        summary: `rewound to before #${checkpoint.id}`,
      },
    })
    lines.push(`对话已分叉到新会话 ${forked}，停在第 ${checkpoint.turn} 回合之前（“${checkpoint.label}”）；原会话不变。打开新会话继续。`)
    if (request.scope === 'conversation') lines.push('文件没有动：它们仍带着之后的修改。')
    return { ok: true, text: lines.join('\n') }
  }

  private forkable(checkpoint: CheckpointRecord): boolean {
    return checkpoint.boundarySeq >= 0
  }

  /** The files went back and the conversation stays: recorded so undo can take it back, and the session is told at its next step. */
  private async filesRewound(sessionId: string, checkpoint: CheckpointRecord, files: FilesRewound): Promise<void> {
    this.record(sessionId, checkpoint, 'files', files.undo, null)
    await this.index?.setNotice(sessionId, {
      text: [
        `The user put the files back to checkpoint #${checkpoint.id}, as they were before "${checkpoint.label}". What was changed since is undone: do not assume those edits exist.`,
        changedText(files.result),
      ].filter(Boolean).join('\n'),
      summary: `files back to #${checkpoint.id}`,
    })
  }

  private record(sessionId: string, checkpoint: CheckpointRecord, scope: RewindScope, undo: string | null, forked: string | null): void {
    void this.index?.addRewind(sessionId, rewindRecord(checkpoint, scope, undo, forked))
  }

  /** DSH's fork path (C7): the history up to the checkpoint seeds a new, persisted session. */
  private async fork(agent: Agent, checkpoint: CheckpointRecord, signal: AbortSignal): Promise<string> {
    const query = this.ctx.get('sessionQuery')
    const agents = this.ctx.get('agents')
    if (query === undefined || agents === undefined) throw new Error('DSH has no sessionQuery or agents service mounted; the conversation cannot be forked')
    const source = agent.session.header
    using observed = await query.observeSession(source.id)
    signal.throwIfAborted()
    const seed = buildForkSeed(observed.events, SessionSeq(checkpoint.boundarySeq))
    const childId = SessionId(`session-${randomUUID()}`)
    const child = await agents.create({
      sessionId: childId,
      seed,
      inheritedEventCount: SessionLogOffset(checkpoint.boundarySeq + 1),
      meta: { ...(source.cwd === undefined ? {} : { cwd: source.cwd }), parentSession: source.id, isSeeded: true },
      agentOptions: { ...agent.options },
    })
    // Nobody drives it here: the person opens it, and DSH resumes it then.
    await child.dispose()
    return childId
  }

  /** `/sieve rewind undo`: the files as they were right before the last rewind. */
  async undo(agent: Agent, signal: AbortSignal): Promise<{ ok: boolean, text: string }> {
    if (agent.status === 'running') return { ok: false, text: '代理还在运行。先停下它，再撤销。' }
    const index = this.index
    if (index === undefined) return { ok: false, text: offText('no_index', this.config) }
    const sessionId = agent.session.header.id
    const last = index.of(sessionId).rewinds.at(-1)
    if (last === undefined) return { ok: false, text: '这个会话没有可撤销的回退。' }
    if (last.undo === null) {
      return { ok: false, text: last.forked === null ? '上一次回退没有动文件。' : `上一次回退只分叉了对话；原来的对话还在，回到原会话即可。` }
    }
    const undoCommit = last.undo
    const refused = this.refusal(last.root)
    if (refused !== undefined) return { ok: false, text: refused }
    const project = this.project(last.root)
    const store = await this.open(project)
    if (!await hasCommit(store, undoCommit)) return { ok: false, text: '回退之前拍的快照已被清理。' }
    const now = await this.exclusive(project, () => scan(store))
    const plan = await this.exclusive(project, () => planRestore(store, undoCommit, now.tree))
    signal.throwIfAborted()
    const redo = await this.exclusive(project, () => snapshot(store, `${sessionId}/undo-${Date.now()}`))
    const result = await this.exclusive(project, () => applyRestore(store, plan, new Set()))
    const after = await this.exclusive(project, () => scan(store))
    void index.setLastTree(sessionId, after.tree)
    void index.addRewind(sessionId, { to: 'undo', scope: 'files', undo: redo.commit, root: last.root, forked: null, at: new Date().toISOString() })
    await index.setNotice(sessionId, {
      text: ['The user undid the last rewind: the files are back as they were right before it.', changedText(result)].filter(Boolean).join('\n'),
      summary: 'rewind undone',
    })
    return { ok: true, text: `已撤销上一次回退：${describeResult(result)}。` }
  }

  status(sessionId: string, agent: Agent | undefined): SieveCheckpointStatus {
    const own = this.index?.of(sessionId)
    const latest = own?.checkpoints.at(-1)
    const root = agent === undefined ? undefined : this.rootOf(agent)
    const off = root === undefined ? (this.machineOff ?? (this.index === undefined ? 'no_index' : undefined)) : this.offFor(root)
    const proposed = agent === undefined ? undefined : this.lives.get(agent)?.proposed
    return {
      enabled: off === undefined,
      off: off === undefined ? null : offText(off, this.config),
      checkpoints: own?.checkpoints.length ?? 0,
      latest: latest === undefined ? null : { id: latest.id, turn: latest.turn, label: latest.label, at: latest.at },
      rewinds: own?.rewinds.length ?? 0,
      proposed: proposed ?? null,
    }
  }
}

function rewindRecord(checkpoint: CheckpointRecord, scope: RewindScope, undo: string | null, forked: string | null): RewindRecord {
  return { to: checkpoint.id, scope, undo, root: checkpoint.root, forked, at: new Date().toISOString() }
}

function changedText(result: RestoreResult): string {
  const changed = [...result.restored, ...result.removed, ...result.broughtBack]
  const kept = result.leftAlone.map(entry => entry.path)
  return [
    changed.length > 0 ? `Files put back: ${listed(changed)}` : '',
    kept.length > 0 ? `Left as they are: ${listed(kept)}` : '',
  ].filter(Boolean).join('\n')
}

/** Mounts checkpoints on a `sieve-runtime` child; the caller keeps the runtime for `/sieve rewind`. */
export function registerCheckpoint(ctx: Context, host: Sieve, runtime: SessionRuntime, deps: CheckpointDeps = {}): CheckpointRuntime {
  registerTurnFacts(ctx)
  const checkpoints = new CheckpointRuntime(ctx, host, runtime, deps)
  // A sub-agent works inside its parent's turn: the parent's checkpoint covers what it changes. The hive watches its bees.
  const watched = (agent: Agent): boolean => agent.session.header.origin !== 'subagent' && host.hive?.isBee(agent) !== true
  const mutating = new WeakSet<object>()

  ctx.effect(() => {
    try { checkpoints.sweep() } catch { /* bookkeeping: a sweep that fails waits for the next start */ }
    return () => checkpoints.dispose()
  }, 'sieve.checkpoints')

  ctx.plugin({
    name: 'sieve-checkpoint-index',
    inject: ['storageDomain'],
    apply: async (child: Context) => {
      const domain = await child.storageDomain.open(checkpointDomain)
      const index = new CheckpointIndex(domain.table('sessions'), child.logger)
      checkpoints.index = index
      child.effect(() => async () => {
        if (checkpoints.index === index) checkpoints.index = undefined
        await index.drain()
        await domain.close()
      }, 'sieve.checkpoint-index')
    },
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent
    const input = typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments as Record<string, unknown> : {}
    if (agent !== undefined && watched(agent) && isMutatingCall(exec.name, input)) {
      mutating.add(exec)
      // A cancelled call does not wait for the snapshot; the snapshot itself goes on for the turn's next change.
      try { await untilAbort(checkpoints.ensure(agent), exec.signal) } catch { /* no checkpoint: the call runs all the same */ }
    }
    return next()
  })

  ctx.on('tools/result', (exec) => {
    if (!mutating.has(exec) || exec.agent === undefined) return
    mutating.delete(exec)
    void checkpoints.noteChange(exec.agent)
  })

  ctx.on('sieve/trouble', (agent, kind, detail) => {
    const facts = checkpoints.factsOf(agent)
    if (facts === undefined || !watched(agent)) return
    checkpoints.turnOf(agent, facts).trouble = `the monitor saw ${kind === 'drift' ? 'a drift from the goal' : kind === 'stalled' ? 'a stalled loop' : 'a loop'}: ${clip(detail, 120)}`
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const { agent, turn } = payload
    if (decision.kind !== 'enter' || !watched(agent)) return decision
    try {
      // A rewind's notice goes before the request it came with: what happened, then what is asked.
      const pending = checkpoints.takeNotice(agent)
      const told = checkpoints.boundary(agent, turn)
      if (pending === undefined && told.length === 0) return decision
      return { ...decision, messages: [...(pending === undefined ? [] : [pending]), ...decision.messages, ...told] }
    } catch {
      ctx.logger.warn('sieve: checkpoints failed at a step boundary; nothing added')
      return decision
    }
  })

  return checkpoints
}
