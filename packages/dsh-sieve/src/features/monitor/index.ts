/**
 * Long-task monitoring: the agent's claims checked against what the log says
 * it did.
 *
 * - `agent/turn-stopping`, `turn.completion`: a closing message that says the
 *   work is finished after an edit nothing ran since earns one nudge per turn,
 *   steered into the same turn.
 * - `tools/pre-execute`, `goal.met`: `update_goal complete` on the active goal
 *   is denied while the goal does not hold (the reason names the unmet fact),
 *   and blocks the goal for the user when the agent is waiting on them.
 * - `agent/pre-step`, `turn.drift`: a loop is a fact (the same call ending
 *   the same way, with the same output, `monitor.repeats` times in a row), so
 *   a rule catches it; drift is a judgment, asked in the background every
 *   `monitor.every` tool results while a goal is active. Either earns a single
 *   `sieve-notice` line at the next step. A goal whose agent goes on looping
 *   for `monitor.stallLoops` such runs is blocked as `sieve-stalled`.
 *
 * Monitoring never acts on a fallback: a judge call that fails or times out
 * leaves the agent alone. In shadow the verdicts are only recorded and
 * nothing waits for them.
 *
 * Ported from mu `packages/kyrn-judge/src/extension/features/{monitor,completion}.ts`
 * and the judge path of `goal.ts`.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type { Decision } from '../../judge/engine.ts'
import { goalMet } from '../../judge/decisions/goal-met.ts'
import type { GoalOutcome } from '../../judge/decisions/goal-met.ts'
import { turnCompletion } from '../../judge/decisions/turn-completion.ts'
import type { CompletionOutcome } from '../../judge/decisions/turn-completion.ts'
import { turnDrift } from '../../judge/decisions/turn-drift.ts'
import { clip } from '../../judge/hive/member.ts'
import type { Sieve } from '../../index.ts'
import { deadline, untilAbort } from '../../runtime/operations.ts'
import type { SessionRuntime } from '../../runtime/session-state.ts'
import type {} from '../../runtime/signals.ts'
import { sieveNotice } from '../../runtime/sources.ts'
import { MONITOR_STATE_KEY, registerMonitorFacts } from './facts.ts'
import type { MonitorFacts } from './facts.ts'

/** Blocked-goal reason codes sieve uses (plan C8). */
export const GOAL_NEEDS_USER = 'sieve-needs-user'
export const GOAL_STALLED = 'sieve-stalled'

interface Pending {
  readonly message: UserMessage
  readonly turn: number
  /** A notice about a goal stays due through the goal's later rounds. */
  readonly goalId: string | undefined
  readonly ledgerId: string | undefined
}

interface Live {
  /** The turn whose completion nudge went out: one per turn. */
  nudgedTurn: number
  /** The repeat run already warned about, and the one that blocked the goal. */
  warned: string | undefined
  blocked: string | undefined
  /** `results` when drift was last asked about, and whether a question is out. */
  driftAt: number
  drifting: boolean
  queue: Pending[]
}

function filesOf(files: readonly string[]): string {
  return files.length <= 5 ? files.join(', ') : `${files.slice(0, 5).join(', ')} and ${files.length - 5} more`
}

export function registerMonitor(ctx: Context, host: Sieve, runtime: SessionRuntime): void {
  registerMonitorFacts(ctx)
  const config = host.config.monitor
  const lives = new WeakMap<Agent, Live>()
  const live = (agent: Agent): Live => {
    let state = lives.get(agent)
    if (state === undefined) {
      state = { nudgedTurn: -1, warned: undefined, blocked: undefined, driftAt: 0, drifting: false, queue: [] }
      lives.set(agent, state)
    }
    return state
  }
  const factsOf = (agent: Agent): MonitorFacts | undefined => ctx.sessionProjections.stateOf(agent.session, MONITOR_STATE_KEY)
  const modeOf = (agent: Agent, id: string) => host.modeOf(id, agent.session.header.id)
  /** The goal the agent works towards on its own: DSH's active goal. */
  const activeGoal = (agent: Agent) => {
    const goal = ctx.get('goals')?.get(agent)
    return goal?.phase === 'active' ? goal : undefined
  }
  // The hive watches its own bees.
  const watched = (agent: Agent): boolean => host.hive?.isBee(agent) !== true
  const annotate = (agent: Agent, ledgerId: string | undefined): void => {
    if (ledgerId !== undefined) void host.track(host.annotate(agent.session.header.id, ledgerId, { applied: true }))
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    const { agent, turn } = payload
    if (decision.kind !== 'enter' || !watched(agent)) return decision
    try {
      const state = live(agent)
      const facts = factsOf(agent)
      const goal = activeGoal(agent)
      const told: UserMessage[] = []
      const mode = modeOf(agent, turnDrift.id)
      const repeat = facts?.repeat
      if (repeat !== undefined && repeat !== null && repeat.count >= config.repeats && mode !== 'off') {
        if (state.warned !== repeat.signature) {
          state.warned = repeat.signature
          ctx.emit('sieve/trouble', agent, 'loop', `${repeat.action} (${repeat.count} times)`)
          runtime.for(agent).engine.recordRules(turnDrift, {
            outcome: 'loop', state: { action: repeat.action, count: repeat.count }, origin: { turn }, applied: mode === 'active',
          })
          if (mode === 'active') {
            told.push(sieveNotice('monitor', `The same call has now run ${repeat.count} times with the same outcome (${repeat.action}). Say what it told you and try a different approach.`, `loop: ${repeat.action}`))
          }
        } else if (goal !== undefined && repeat.count >= config.repeats * config.stallLoops && state.blocked !== repeat.signature) {
          state.blocked = repeat.signature
          ctx.emit('sieve/trouble', agent, 'stalled', `${repeat.action} (${repeat.count} times)`)
          runtime.for(agent).engine.recordRules(turnDrift, {
            outcome: 'loop', state: { action: repeat.action, count: repeat.count, stalled: true }, origin: { turn, goalId: goal.id }, applied: mode === 'active',
          })
          if (mode === 'active') {
            ctx.get('goals')?.block(agent, { id: goal.id, revision: goal.revision }, {
              code: GOAL_STALLED,
              message: `sieve: the same call ran ${repeat.count} times with the same outcome (${clip(repeat.action, 200)}).`,
            })
            told.push(sieveNotice('monitor', `The goal is blocked for the user: the same call has run ${repeat.count} times with the same outcome (${repeat.action}). Stop repeating it; say what you found and what you need.`, `stalled: ${repeat.action}`))
          }
        }
      }
      if (goal !== undefined && facts !== undefined && mode !== 'off' && !state.drifting && facts.results - state.driftAt >= config.every) {
        state.driftAt = facts.results
        state.drifting = true
        const objective = clip(goal.objective, 600)
        void runtime.for(agent).engine.decide(turnDrift, { goal: objective, recentActions: facts.actions.slice(-config.window) }, {
          signal: runtime.for(agent).controller.signal, applied: false, origin: { turn, goalId: goal.id },
        }).then((value) => {
          if (value.source !== 'judge' || value.outcome !== 'drift') return
          ctx.emit('sieve/trouble', agent, 'drift', `the recent steps look unrelated to "${clip(objective, 120)}"`)
          state.queue.push({
            message: sieveNotice('monitor', `Check your course: the recent steps look unrelated to the goal ("${objective}"). Return to it or say why the detour is needed.`, 'drift from the goal'),
            turn,
            goalId: goal.id,
            ledgerId: value.ledgerId,
          })
        }).catch(() => {}).finally(() => { state.drifting = false })
      }
      // Notices of an earlier turn are stale, unless they are about the goal still being worked on.
      const due = state.queue.splice(0).filter(item => item.turn === turn || (item.goalId !== undefined && item.goalId === goal?.id))
      for (const item of due) {
        told.push(item.message)
        annotate(agent, item.ledgerId)
      }
      return told.length === 0 ? decision : { ...decision, messages: [...decision.messages, ...told] }
    } catch {
      ctx.logger.warn('sieve: monitor failed at a step boundary; nothing added')
      return decision
    }
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (!watched(agent)) return
    const mode = modeOf(agent, turnCompletion.id)
    // With a goal running, `goal.met` checks the claim, with these same facts. One voice is enough.
    if (mode === 'off' || activeGoal(agent) !== undefined) return
    const state = live(agent)
    const facts = factsOf(agent)
    if (state.nudgedTurn === turn || facts === undefined || facts.edited.length === 0 || facts.unverified.length === 0) return
    const task = runtime.task(agent)
    const finalMessage = task?.lastAssistant ?? ''
    if (finalMessage.trim() === '') return
    const input = {
      userMessage: clip(task?.lastUser ?? '', 400),
      finalMessage: clip(finalMessage, 600),
      editedFiles: facts.edited.length,
      ranCommandAfterLastEdit: false,
    }
    const cancel = AbortSignal.any([signal, runtime.for(agent).controller.signal])
    const work = runtime.for(agent).engine.decide(turnCompletion, input, { signal: cancel, applied: false, origin: { turn } })
    // Shadow records what it would have said; only an active verdict is worth holding the end of the turn for.
    if (mode !== 'active') {
      void work.catch(() => {})
      return
    }
    let decided: Decision<CompletionOutcome> | undefined
    const bound = deadline(cancel, config.waitMs)
    try { decided = await untilAbort(work, bound.signal) } catch { decided = undefined } finally { bound.dispose() }
    if (decided?.source !== 'judge' || decided.outcome !== 'nudge' || signal.aborted) return
    state.nudgedTurn = turn
    agent.steer(sieveNotice('monitor', `You edited ${filesOf(facts.unverified)} and nothing has run since. Verify the change (run the relevant test, build or command), or say plainly why it cannot be verified here.`, 'unverified edit'))
    annotate(agent, decided.ledgerId)
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent
    const args = exec.arguments as { readonly action?: unknown, readonly goal_id?: unknown }
    if (exec.name !== 'update_goal' || args.action !== 'complete' || agent === undefined || !watched(agent)) return next()
    const goal = activeGoal(agent)
    const mode = modeOf(agent, goalMet.id)
    // Anything else about the call is the goal tool's to reject.
    if (goal === undefined || args.goal_id !== goal.id || mode === 'off') return next()
    const unverified = factsOf(agent)?.unverified ?? []
    const input = { goal: clip(goal.objective, 600), finalMessage: clip(runtime.task(agent)?.lastAssistant ?? '', 800), unverified: unverified.length > 0 }
    const cancel = AbortSignal.any([exec.signal, runtime.for(agent).controller.signal])
    const work = runtime.for(agent).engine.decide(goalMet, input, { signal: cancel, applied: false, origin: { callId: exec.callId, goalId: goal.id } })
    if (mode !== 'active') {
      void work.catch(() => {})
      return next()
    }
    let decided: Decision<GoalOutcome> | undefined
    const bound = deadline(cancel, config.waitMs)
    try { decided = await untilAbort(work, bound.signal) } catch { decided = undefined } finally { bound.dispose() }
    if (decided?.source !== 'judge' || decided.outcome === 'met' || decided.outcome === 'unjudged') return next()
    const current = activeGoal(agent)
    if (current?.id !== goal.id) return next()
    if (decided.outcome === 'ask') {
      ctx.get('goals')?.block(agent, { id: current.id, revision: current.revision }, {
        code: GOAL_NEEDS_USER,
        message: 'sieve: the agent asked for something the work cannot go on without; see its last message.',
      })
      annotate(agent, decided.ledgerId)
      return { kind: 'deny', reason: 'The goal is blocked until the user answers: you asked for something the work cannot go on without. Stop here and wait for them.' }
    }
    annotate(agent, decided.ledgerId)
    const facts = unverified.length > 0
      ? `You edited ${filesOf(unverified)} and nothing has run since. Verify the change.`
      : 'Your last message does not show that it holds. Keep working, or say exactly what remains.'
    return { kind: 'deny', reason: `The goal is not met yet ("${input.goal}"). ${facts}` }
  }, { prepend: true })
}
