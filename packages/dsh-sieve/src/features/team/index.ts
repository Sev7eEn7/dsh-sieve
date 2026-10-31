/**
 * The team supervisor (harness plan §4 phase 6). DSH's agent team keeps a
 * roster and a task board but nobody watches them: an owner is never
 * released, a task marked done is never checked, write scopes only warn, a
 * ready task waits for someone to claim it. sieve watches and acts as the
 * Lead, for release, assignment and interrupt only (D4, C9):
 *
 * - stuck: a member the monitor finds looping or stalled gets the hive
 *   suggested to the Lead once; after `stuckAfter` such signals it is
 *   interrupted, its in-progress tasks go back to the board, and the Lead is
 *   told why (`team.release`, rules);
 * - done: a task a member completes is held against what the member did in
 *   that turn (`team.verify`); when that cannot settle it, a read-only
 *   verifier is started with `outputSchema: { verdict, failures }`; a task
 *   that does not hold up is reopened and its owner told;
 * - shared files: an edit inside another member's in-progress write scope is
 *   weighed (`team.conflict`), and held unless it does not interfere: the
 *   member is told to coordinate (a sub-agent cannot be asked);
 * - ready work: a ready, unowned task and an idle member without work are
 *   matched (`team.dispatch`), and the member is woken with the task;
 * - after a crash: an in-progress task whose owner was cut off mid-turn is
 *   classified as in phase 5 (`resume.safety`), and the owner is woken to go
 *   on or the task is released.
 *
 * Every action defaults to shadow (D5): the ledger records what would have
 * been done. A judgment that fails changes nothing, except a held edit, which
 * stays held.
 *
 * New in sieve.
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type { TeamMembership, TeamTaskId, TeamTaskView } from '@deepseek-ai/dsh-experimental-agent-team'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-working-directory'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { resumeSafety } from '../../judge/decisions/resume-safety.ts'
import type { ResumeOutcome } from '../../judge/decisions/resume-safety.ts'
import { teamConflict, teamDispatch, teamRelease, teamVerify } from '../../judge/decisions/team.ts'
import type { VerifyOutcome } from '../../judge/decisions/team.ts'
import { clip } from '../../judge/hive/member.ts'
import { FILE_WRITE_TOOLS, isMutatingCall } from '../../judge/monitor/mutating.ts'
import type { Sieve } from '../../index.ts'
import type { SessionRuntime } from '../../runtime/session-state.ts'
import type {} from '../../runtime/signals.ts'
import { sieveNotice } from '../../runtime/sources.ts'
import { registerTurnFacts } from '../checkpoint/facts.ts'
import { describeCall } from '../admission-rules.ts'
import { foldResume, INITIAL_RESUME_FACTS, resumeText } from '../resume/index.ts'

export const TEAM_STEPS_KEY = 'sieve/team-steps'

const TASK_UPDATE_TOOL = 'team_task_update'

/** The verdict a read-only verifier hands back. */
const VERIFIER_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    failures: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'failures'],
  additionalProperties: false,
} as const

/** Tools a verifier may not use: it looks, runs checks and reports, and changes nothing. */
const VERIFIER_DENIED: readonly string[] = [...FILE_WRITE_TOOLS, 'subagent', 'subagent_fork', 'spawn_teammate', 'create_worktree', 'hive', TASK_UPDATE_TOOL]

const text = (value: unknown): string => typeof value === 'string' ? value : ''

function argumentsOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Whether `path` (workspace-relative) falls inside a write scope (a workspace-relative prefix). */
export function inScope(path: string, scope: string): boolean {
  const clean = (value: string) => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  const target = clean(path)
  const prefix = clean(scope)
  return prefix === '' || target === prefix || target.startsWith(`${prefix}/`)
}

/** The path an edit writes, relative to the workspace; undefined outside it. */
function workspacePath(cwd: string | undefined, raw: string): string | undefined {
  if (raw === '') return undefined
  if (cwd === undefined) return raw.startsWith('/') ? undefined : raw
  if (!raw.startsWith('/')) return raw
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`
  return raw.startsWith(base) ? raw.slice(base.length) : undefined
}

export function registerTeam(ctx: Context, host: Sieve, runtime: SessionRuntime): void {
  const config = host.config.team
  const teams = ctx.agentTeams
  registerTurnFacts(ctx, TEAM_STEPS_KEY)

  const lifetime = new AbortController()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const work = new Set<Promise<unknown>>()
  /** Monitor signals per member since its work last changed hands, keyed `team/name`: the Agent is released after an interrupt (C9). */
  const troubles = new Map<string, number>()
  /** Dispatch asked once per task revision. */
  const dispatched = new Set<string>()
  /** Read-only verifiers by child session id. */
  const verifiers = new Set<string>()
  /** The verifiers running now: an activation's signal only cancels its start, so unloading disposes them. */
  const checking = new Set<SubagentActivation>()
  /** Tasks the supervisor is moving itself, which dispatch leaves alone meanwhile. */
  const moving = new Set<string>()
  /** Who each released task was taken from: dispatch does not hand it straight back. */
  const releasedFrom = new Map<string, string>()
  ctx.effect(() => () => {
    lifetime.abort(new Error('sieve team supervisor unloaded'))
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const activation of checking) void activation.dispose().catch(() => undefined)
    return Promise.allSettled([...work]).then(() => undefined)
  }, 'sieve.team')

  /** Outside the event that prompted it: an observer must not append to the log it observes. */
  const later = (label: string, job: () => Promise<void>): void => {
    if (lifetime.signal.aborted) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      const running = job().catch((error: unknown) => {
        ctx.logger.warn(`sieve: team ${label} failed: ${String(error)}`)
      })
      work.add(running)
      void running.finally(() => work.delete(running))
    }, 0)
    timers.add(timer)
  }

  const modeOf = (id: string, lead: Agent) => host.modeOf(id, lead.session.header.id)
  const engineOf = (lead: Agent) => runtime.for(lead).engine
  const tell = (lead: Agent, message: string, summary: string): void => {
    lead.inject(sieveNotice('team', message, summary))
  }
  const send = (lead: Agent, target: string, message: string): Promise<unknown> =>
    teams.sendMessage(lead, { target, content: [{ type: 'text', text: message }], signal: lifetime.signal })

  /** Compare-and-set against the latest revision; a task that moved on meanwhile is left alone. */
  const update = async (lead: Agent, task: TeamTaskView, action: 'release' | 'reopen' | 'reassign', owner?: string): Promise<TeamTaskView | undefined> => {
    const latest = teams.getTask(lead, task.id)
    if (latest.status !== task.status || latest.ownerName !== task.ownerName) return undefined
    return teams.updateTask(lead, { taskId: task.id, expectedRevision: latest.revision, action, ...owner === undefined ? {} : { owner } })
  }

  /** Marked before the update: the board change prompts a dispatch that must already see it. */
  const release = async (lead: Agent, task: TeamTaskView, from: string): Promise<boolean> => {
    releasedFrom.set(task.id, from)
    const done = await update(lead, task, 'release').catch(() => undefined) !== undefined
    if (!done) releasedFrom.delete(task.id)
    return done
  }

  const membershipOf = (agent: Agent | undefined): TeamMembership | undefined => agent === undefined ? undefined : teams.tryMembership(agent)

  // Stuck: suggest the hive once, then release.
  ctx.on('sieve/trouble', (agent, kind, detail) => {
    const member = membershipOf(agent)
    if (member === undefined || member.role !== 'teammate') return
    const lead = member.root
    const mode = modeOf(teamRelease.id, lead)
    if (mode === 'off') return
    const key = `${member.id}/${member.name}`
    const count = (troubles.get(key) ?? 0) + 1
    troubles.set(key, count)
    const engine = engineOf(lead)
    const evidence = `${kind}: ${detail}`
    if (count < config.stuckAfter) {
      if (count !== 1 || !host.config.hive.enabled) return
      engine.recordRules(teamRelease, { outcome: 'suggest-hive', state: { member: member.name, evidence }, applied: mode === 'active' })
      if (mode === 'active') {
        tell(lead, `Teammate "${member.name}" looks stuck (${evidence}). If it is a bug nobody has pinned down, the hive tool can put several investigators on it at once; only suggest it, the user decides.`, `${member.name} looks stuck`)
      }
      return
    }
    troubles.delete(key)
    const name = member.name
    later('release', async () => {
      const owned = teams.listTasks(lead).filter(task => task.status === 'in_progress' && task.ownerName === name)
      engine.recordRules(teamRelease, { outcome: 'release', state: { member: name, evidence, tasks: owned.map(task => task.id) }, applied: mode === 'active' })
      if (mode !== 'active') return
      try {
        teams.interrupt(lead, name)
      } catch (error) {
        ctx.logger.warn(`sieve: could not interrupt teammate ${name}: ${String(error)}`)
      }
      const released: string[] = []
      for (const task of owned) {
        if (await release(lead, task, name)) released.push(`${task.id} "${clip(task.subject, 60)}"`)
      }
      const freed = released.length === 0 ? 'It held no task.' : `Its tasks are back on the board: ${released.join(', ')}.`
      tell(lead, `sieve interrupted teammate "${name}": it kept failing the same way (${evidence}). ${freed} Decide whether to hand the work to someone else or to change the approach first.`, `released ${name}`)
    })
  })

  // Done: verify what a member completed.
  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== TASK_UPDATE_TOOL || result.isError) return
    const args = argumentsOf(exec.arguments)
    if (args['action'] !== 'complete') return
    const member = membershipOf(exec.agent)
    if (member === undefined || member.role !== 'teammate' || exec.agent === undefined) return
    troubles.delete(`${member.id}/${member.name}`)
    const lead = member.root
    const mode = modeOf(teamVerify.id, lead)
    if (mode === 'off') return
    const facts = ctx.sessionProjections.stateOf(exec.agent.session, TEAM_STEPS_KEY)
    const taskId = text(args['task_id']) as TeamTaskId
    const owner = member.name
    later('verify', async () => {
      const task = teams.getTask(lead, taskId)
      const decision = await engineOf(lead).decide(teamVerify, {
        task: task.subject,
        description: clip(task.description, 600),
        steps: facts?.steps ?? [],
        lastCheckFailed: facts?.lastCheckFailed ?? undefined,
        edits: facts?.edits ?? 0,
      }, { signal: lifetime.signal, applied: false, origin: { taskId, owner } })
      if (mode !== 'active' || decision.source !== 'judge') return
      let outcome: VerifyOutcome = decision.outcome
      let failures: string[] = []
      if (outcome === 'unsure' && config.verifier) {
        const verdict = await verifyByChild(lead, task, facts?.steps ?? [])
        if (verdict === undefined) return
        outcome = verdict.verdict === 'pass' ? 'accept' : 'reopen'
        failures = verdict.failures
      }
      if (outcome !== 'reopen') return
      const latest = teams.getTask(lead, taskId)
      if (latest.status !== 'completed') return
      moving.add(taskId)
      let handedBack = false
      try {
        const reopened = await update(lead, latest, 'reopen')
        if (reopened === undefined) return
        if (decision.ledgerId !== undefined) void host.track(host.annotate(lead.session.header.id, decision.ledgerId, { applied: true }))
        // DSH reopens a task unowned; it goes back to whoever completed it, if that member is still on the team.
        handedBack = await update(lead, reopened, 'reassign', owner).catch(() => undefined) !== undefined
      } finally {
        moving.delete(taskId)
      }
      const why = failures.length > 0 ? failures.map(line => `- ${clip(line, 200)}`).join('\n') : facts?.lastCheckFailed === true ? '- the last test, build or check run failed' : '- what was done does not show the task finished'
      if (handedBack) await send(lead, owner, `sieve reopened ${task.id} "${task.subject}" and handed it back to you: it does not hold up yet.\n${why}\nFix it, run the checks, then complete it again.`)
      tell(lead, `sieve reopened ${task.id} "${clip(task.subject, 80)}" that "${owner}" had completed${handedBack ? ', and handed it back' : '; it is back on the board'}:\n${why}`, `reopened ${task.id}`)
    })
  })

  /**
   * A read-only child that runs the checks and hands back a verdict; undefined
   * when it could not, or did not within `team.verifierMinutes`.
   */
  const verifyByChild = async (lead: Agent, task: TeamTaskView, steps: readonly string[]): Promise<{ verdict: 'pass' | 'fail', failures: string[] } | undefined> => {
    const childId = SessionId(randomUUID())
    verifiers.add(childId)
    let activation: SubagentActivation | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let late = false
    try {
      activation = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: `sieve verify: ${task.id}`,
        childId,
        request: {
          parent: lead,
          prompt: [{ type: 'text', text: [
            `Check whether team task ${task.id} is really done. Change nothing: read the code and run the project's tests, build or checks.`,
            `Task: ${task.subject}`,
            task.description === '' ? '' : `Details: ${clip(task.description, 1200)}`,
            steps.length === 0 ? '' : `What its owner did last:\n${steps.map(step => `- ${step}`).join('\n')}`,
            'Report "pass" only if the work the task asks for is there and the checks pass; otherwise "fail", with one line per problem.',
          ].filter(Boolean).join('\n\n') }],
          outputSchema: VERIFIER_SCHEMA as never,
        },
        signal: lifetime.signal,
        delivery: 'caller',
      })
      checking.add(activation)
      const started = activation
      if (config.verifierMinutes > 0) {
        deadline = setTimeout(() => {
          late = true
          void started.dispose().catch(() => undefined)
        }, config.verifierMinutes * 60_000)
      }
      const result = await activation.result
      if (late) {
        ctx.logger.warn(`sieve: the verifier of ${task.id} did not report within ${config.verifierMinutes} min and was stopped`)
        return undefined
      }
      const structured = argumentsOf(result.structured)
      const verdict = structured['verdict']
      if (verdict !== 'pass' && verdict !== 'fail') return undefined
      const failures = Array.isArray(structured['failures']) ? structured['failures'].filter((line): line is string => typeof line === 'string') : []
      return { verdict, failures }
    } catch (error) {
      ctx.logger.warn(`sieve: the verifier of ${task.id} did not report: ${String(error)}`)
      return undefined
    } finally {
      clearTimeout(deadline)
      verifiers.delete(childId)
      if (activation !== undefined) {
        checking.delete(activation)
        await activation.dispose().catch(() => undefined)
      }
    }
  }

  ctx.on('agent/created', ({ agent, source }) => {
    if (verifiers.has(agent.session.header.id)) {
      const hidden = VERIFIER_DENIED.filter(name => ctx.tools.get(name) !== undefined)
      if (hidden.length > 0) agent.ctx.tools.restrict({ deny: hidden })
      if (source !== 'resume' && ctx.get('sandboxPolicy') !== undefined) setSandboxMode(agent.session, 'read-only')
      return undefined
    }
    // The team is restored from the Lead's log as it resumes: ask about the role afterwards.
    if (source === 'resume') later('resume', () => membershipOf(agent)?.role === 'lead' ? resumeTeam(agent) : Promise.resolve())
    return undefined
  })

  // Shared files, and the verifier's closed tools.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent
    if (agent === undefined) return next()
    // The verifier runs checks through the shell, which its read-only sandbox confines.
    if (verifiers.has(agent.session.header.id) && VERIFIER_DENIED.includes(exec.name)) {
      return { kind: 'deny', reason: `${exec.name} is not available to a verifier: check and report, change nothing.` }
    }
    if (!FILE_WRITE_TOOLS.includes(exec.name)) return next()
    const args = argumentsOf(exec.arguments)
    if (exec.name === 'str_replace_editor' && args['command'] === 'view') return next()
    const member = membershipOf(agent)
    if (member === undefined) return next()
    const lead = member.root
    const mode = modeOf(teamConflict.id, lead)
    if (mode === 'off') return next()
    const cwd = ctx.get('workingDirectory')?.get(agent.session) ?? agent.session.header.cwd
    const path = workspacePath(cwd, text(args['file_path']) || text(args['path']))
    if (path === undefined) return next()
    const tasks = teams.listTasks(lead).filter(task => task.status === 'in_progress')
    const theirs = tasks.find(task => task.ownerName !== member.name && task.writeScopes.some(scope => inScope(path, scope)))
    if (theirs === undefined) return next()
    const mine = tasks.filter(task => task.ownerName === member.name).map(task => task.subject).join('; ')
    const scope = theirs.writeScopes.find(each => inScope(path, each)) ?? ''
    const decision = await engineOf(lead).decide(teamConflict, {
      edit: clip(describeCall(exec.name, args), 300),
      mine: mine === '' ? '(no task of its own)' : clip(mine, 300),
      theirs: clip(theirs.subject, 300),
      owner: theirs.ownerName ?? '',
      scope,
    }, { signal: exec.signal, applied: false, origin: { callId: exec.callId, member: member.name } })
    if (mode !== 'active' || decision.outcome === 'allow') return next()
    if (decision.ledgerId !== undefined) void host.track(host.annotate(lead.session.header.id, decision.ledgerId, { applied: true }))
    const reason = `sieve: ${path} is in the write scope "${scope}" of ${theirs.id} "${clip(theirs.subject, 80)}", which ${theirs.ownerName ?? 'another member'} is working on.`
    // A teammate's session is pinned to the `never` policy, where an ask would be rejected without a word.
    const approval = ctx.get('approval')
    if (member.role === 'teammate' || approval === undefined || approval.overrideOf(agent.session) === 'never') {
      return { kind: 'deny', reason: `${reason} Coordinate with ${theirs.ownerName ?? 'its owner'} (send_message) or the Lead before changing it.` }
    }
    const downstream = await next()
    if (downstream.kind !== 'allow') return downstream
    return { kind: 'ask', reason, displayReason: { en: reason, zh: `sieve：${path} 在 ${theirs.ownerName ?? '其他成员'} 正在做的 ${theirs.id}（${clip(theirs.subject, 80)}）的写入范围 "${scope}" 里。` } }
  })

  // Ready work: match it with an idle member.
  const dispatch = async (lead: Agent): Promise<void> => {
    const mode = modeOf(teamDispatch.id, lead)
    if (mode === 'off') return
    const tasks = teams.listTasks(lead)
    const busy = new Set(tasks.filter(task => task.status === 'in_progress').map(task => task.ownerName))
    const ready = tasks.find(task => task.status === 'pending' && task.ready && task.ownerName === undefined && !moving.has(task.id) && !dispatched.has(`${task.id}@${task.revision}`))
    if (ready === undefined) return
    const idle = teams.listMembers(lead).filter(member => member.role === 'teammate' && member.status === 'inactive' && !busy.has(member.name) && releasedFrom.get(ready.id) !== member.name)
    if (idle.length === 0) return
    dispatched.add(`${ready.id}@${ready.revision}`)
    const members = Object.fromEntries(idle.map(member => [member.name, clip(member.description ?? member.name, 200)]))
    const decision = await engineOf(lead).decide(teamDispatch, { task: ready.subject, description: clip(ready.description, 600), members }, { signal: lifetime.signal, applied: false, origin: { taskId: ready.id } })
    const name = decision.outcome
    if (mode !== 'active' || decision.source !== 'judge' || name === null || members[name] === undefined) return
    if (await update(lead, ready, 'reassign', name) === undefined) return
    if (decision.ledgerId !== undefined) void host.track(host.annotate(lead.session.header.id, decision.ledgerId, { applied: true }))
    await send(lead, name, `sieve assigned you ${ready.id} "${ready.subject}" for the Lead.${ready.description === '' ? '' : `\n${clip(ready.description, 1200)}`}\nWhen it is done and checked, complete it with ${TASK_UPDATE_TOOL}.`)
    tell(lead, `sieve assigned ${ready.id} "${clip(ready.subject, 80)}" to "${name}", who was idle.`, `assigned ${ready.id}`)
  }

  const leadOfSession = (sessionId: SessionId): Agent | undefined => {
    const agent = ctx.agents.get(sessionId)
    const member = membershipOf(agent)
    return member?.role === 'lead' ? member.root : undefined
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'team/task') return
    const lead = leadOfSession(session.header.id)
    if (lead !== undefined) later('dispatch', () => dispatch(lead))
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const member = membershipOf(agent)
    if (member?.role === 'teammate') later('dispatch', () => dispatch(member.root))
  })

  // After a crash: wake or release each owner that was cut off.
  const resumeTeam = async (lead: Agent): Promise<void> => {
    const mode = modeOf(teamRelease.id, lead)
    const query = ctx.get('sessionQuery')
    if (mode === 'off' || query === undefined) return
    const ids = new Map(teams.listMembers(lead).map(member => [member.name, member.id]))
    for (const task of teams.listTasks(lead)) {
      if (task.status !== 'in_progress' || task.ownerName === undefined) continue
      const id = ids.get(task.ownerName)
      if (id === undefined || ctx.agents.get(id)?.status === 'running') continue
      const cut = await cutOff(query, id)
      if (cut === undefined) continue
      const owner = task.ownerName
      let outcome: ResumeOutcome = 'idempotent'
      let line = ''
      if (cut.call !== undefined) {
        const input = argumentsOf(safeParse(cut.call.arguments))
        line = clip(describeCall(cut.call.name, input), 200)
        if (!isMutatingCall(cut.call.name, input)) outcome = 'read_only'
        else {
          const decided = await engineOf(lead).decide(resumeSafety, {
            tool: cut.call.name, call: line, arguments: clip(cut.call.arguments, 600), changesFiles: true, request: cut.request,
          }, { signal: lifetime.signal, applied: false, origin: { taskId: task.id, owner } })
          outcome = decided.source === 'judge' ? decided.outcome : 'unknown'
        }
      }
      const wake = outcome === 'read_only' || outcome === 'idempotent' || outcome === 'verify_first'
      engineOf(lead).recordRules(teamRelease, { outcome: wake ? 'wake' : 'release', state: { member: owner, task: task.id, call: line, class: outcome }, applied: mode === 'active' })
      if (mode !== 'active') continue
      if (wake) {
        const how = cut.call === undefined ? 'It stopped between steps.' : resumeText(outcome as Exclude<ResumeOutcome, 'unknown'>, line, undefined)
        await send(lead, owner, `sieve: the session stopped while you worked on ${task.id} "${task.subject}". ${how} Then carry on with the task.`)
        continue
      }
      if (!await release(lead, task, owner)) continue
      tell(lead, `The session stopped while teammate "${owner}" ran \`${line}\` for ${task.id} "${clip(task.subject, 80)}". Running it again could repeat its effects, so sieve released the task: check what it changed before handing it out again.`, `released ${task.id}`)
    }
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * Whether a member's last turn was cut off, read from its stored log: a turn
 * DSH closed as interrupted, or one that never closed (the member has not
 * been restored yet). `call` is the unfinished tool call, when there was one.
 */
async function cutOff(query: Context['sessionQuery'], id: SessionId): Promise<{ call?: { name: string, arguments: string }, request: string } | undefined> {
  using observed = await query.observeSession(id)
  let facts = INITIAL_RESUME_FACTS
  let open = false
  for (const event of observed.events as readonly SessionEvent[]) {
    facts = foldResume(facts, event)
    if (event.type === 'turn/start') open = true
    if (event.type === 'turn/end') open = false
  }
  if (!open && !facts.interrupted) return undefined
  const call = facts.interrupted ? facts.unknown.at(-1) : Object.values(facts.open).at(-1)
  return { ...call === undefined ? {} : { call: { name: call.name, arguments: call.arguments } }, request: facts.request }
}
