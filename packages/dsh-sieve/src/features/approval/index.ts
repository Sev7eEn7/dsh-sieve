/**
 * Jev approval (harness plan §4 phase 3, D2). With `approval.enabled` sieve
 * owns DSH's single Auto permission preset the way
 * `@deepseek-ai/dsh-experimental-auto-review` does (C6): `registerAuto` plus
 * a prepended `tools/pre-execute` gate that acts only while a session's
 * current preset is Auto. Under any other preset nothing changes.
 *
 * Under Auto, a call goes through three layers, and only a sure yes runs it
 * without the user:
 *
 * - rules: a call that only looks, or edits a file of the project, runs (the
 *   checkpoint can take an edit back); a command that sends credentials to
 *   another machine is refused outright; a touch of DSH's own folders is the
 *   user's to allow, every time;
 * - `tool.risk`: a command a rule flags runs only when Jev is sure the user
 *   asked for it;
 * - `tool.approval`: the rest runs only when Jev is sure (>= 0.8) it is a
 *   step the task needs.
 *
 * Everything else, a judge that does not answer included, asks the user with
 * what Jev saw (`displayReason`). Where nobody can be asked (DSH pins child
 * sessions to the `never` policy, which would reject an ask silently) the
 * call is refused with a reason the model can report. In a sub-agent only the
 * user's own request vouches for a call, never the brief its parent wrote.
 *
 * New in sieve; the policy is mu's `permissions.ts` Jev mode.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-working-directory'
import { askText, reviewCall } from '../../judge/approval/review.ts'
import type { Review } from '../../judge/approval/review.ts'
import { harnessFolders } from '../../judge/approval/rules.ts'
import { clip } from '../../judge/hive/member.ts'
import type { Sieve } from '../../index.ts'
import type { SessionRuntime, TaskState } from '../../runtime/session-state.ts'
import { describeCall } from '../admission-rules.ts'

/** DSH's fixed name of the Auto preset (`AUTO_PRESET` of `@deepseek-ai/dsh-permission-presets`; the tests hold them equal). */
export const AUTO_PRESET = 'auto'

/** How many parents up a sub-agent's request is looked for. */
const MAX_DEPTH = 8

export function registerApproval(ctx: Context, host: Sieve, runtime: SessionRuntime): void {
  const presets = ctx.permissionPresets
  const folders = harnessFolders()
  let accepting = true
  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()

  /** The user's own words for this session: its own, or, in a sub-agent, the nearest parent's that has them. */
  const requestOf = (agent: Agent): TaskState | undefined => {
    let current: Agent | undefined = agent
    for (let depth = 0; current !== undefined && depth < MAX_DEPTH; depth++) {
      const header: Agent['session']['header'] = current.session.header
      if (header.origin !== 'subagent') return runtime.task(current)
      current = header.parentSession === undefined ? undefined : ctx.agents.get(header.parentSession)
    }
    return undefined
  }

  ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const agent = exec.agent
      // The outer `run_code` only transports; each call it makes comes through here on its own.
      if (agent === undefined || (exec.parent === undefined && exec.name === RUN_CODE_NAME)) return next()
      if (presets.current(agent.session) !== AUTO_PRESET) return next()
      if (!accepting || lifetime.signal.aborted) return { kind: 'cancel' }
      const signal = AbortSignal.any([exec.signal, lifetime.signal])
      const input = typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments as Record<string, unknown> : {}
      const call = {
        name: exec.name,
        input,
        cwd: ctx.get('workingDirectory')?.get(agent.session) ?? agent.session.header.cwd,
        request: requestOf(agent),
        callId: exec.callId,
      }
      const work = reviewCall(call, runtime.for(agent).engine, { folders, signal }).catch((error: unknown): Review => {
        // A gate that failed must not open: the user decides.
        ctx.logger.warn(`sieve: approval review of ${exec.name} failed: ${String(error)}`)
        return { kind: 'ask', need: { kind: 'other', summary: clip(describeCall(exec.name, input), 300) }, why: 'judgedown' }
      })
      active.add(work)
      let verdict: Review
      try {
        verdict = await work
      } finally {
        active.delete(work)
      }
      if (signal.aborted) return { kind: 'cancel' }
      if (verdict.kind === 'deny') return { kind: 'deny', reason: verdict.reason }
      if (verdict.kind === 'allow') {
        const downstream = await next()
        if (verdict.judged !== undefined && downstream.kind === 'allow') void host.track(host.annotate(agent.session.header.id, verdict.judged, { applied: true }))
        return downstream
      }
      const text = askText(verdict.need.summary, verdict.why, verdict.flag)
      const english = text.en.replace(/\n/g, ' ')
      // DSH rejects an ask silently where the policy is `never`; the model is told why instead.
      if (ctx.approval.overrideOf(agent.session) === 'never') {
        return { kind: 'deny', reason: `${english} There is nobody to ask in this session. Do not try another way around it; say what you needed.` }
      }
      const downstream = await next()
      if (downstream.kind !== 'allow') return downstream
      return { kind: 'ask', reason: english, displayReason: text }
    }, { prepend: true })
    yield presets.registerAuto(() => {
      if (!accepting) throw new Error('sieve: Jev approval is closing')
    })
    yield async () => {
      accepting = false
      try {
        // Auto without its gate would run everything: sessions in it go back to the default preset.
        for (const session of ctx.sessions.list()) {
          if (presets.current(session) === AUTO_PRESET) presets.set(session, presets.defaultPreset)
        }
      } finally {
        lifetime.abort(new Error('sieve approval unloaded'))
        await Promise.allSettled([...active])
      }
    }
  }, 'sieve.approval')
}
