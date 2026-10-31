/**
 * Crash-resume classification. A session whose process died while a tool ran
 * cold-restores with that turn ended `interrupted`, and DSH answers the
 * unfinished call with a `TOOL_OUTCOME_UNKNOWN` error that tells the model
 * only to decide from the tool's semantics (C10). On `agent/created` with
 * source `resume`, `resume.safety` classifies that call, and one
 * `sieve-notice` says what to do: run it again, check first, or do not
 * repeat it. Where it may have broken something and the session has a
 * checkpoint, the notice suggests `/sieve rewind files` to the user.
 *
 * What happened is folded from the native log as a host-only session
 * projection. A judgment that fails, times out or is unsure adds nothing; in
 * shadow the verdict is only recorded.
 *
 * New in sieve (harness plan §4 phase 5).
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { resumeSafety } from '../../judge/decisions/resume-safety.ts'
import type { ResumeOutcome } from '../../judge/decisions/resume-safety.ts'
import { clip } from '../../judge/hive/member.ts'
import { isMutatingCall } from '../../judge/monitor/mutating.ts'
import type { Sieve } from '../../index.ts'
import type { SessionRuntime } from '../../runtime/session-state.ts'
import { textOf } from '../../runtime/session-state.ts'
import { sieveNotice } from '../../runtime/sources.ts'
import { describeCall } from '../admission-rules.ts'

export const RESUME_STATE_KEY = 'sieve/resume'

/** The code DSH's crash recovery gives the result of a call it cannot know the outcome of. */
export const OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

const MAX_ARGUMENTS = 600

interface Call {
  readonly callId: string
  readonly name: string
  readonly arguments: string
}

export interface ResumeFacts {
  readonly turn: number
  /** The request the turn works on. */
  readonly request: string
  /** Calls of the turn without a result yet. */
  readonly open: Readonly<Record<string, Call>>
  /** Calls of the turn whose outcome nobody knows, oldest first. */
  readonly unknown: Call[]
  /** Whether the turn ended `interrupted`. */
  readonly interrupted: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'sieve/resume': ResumeFacts
  }
}

export const INITIAL_RESUME_FACTS: ResumeFacts = { turn: 0, request: '', open: {}, unknown: [], interrupted: false }
const INITIAL = INITIAL_RESUME_FACTS

export function foldResume(state: ResumeFacts, event: SessionEvent): ResumeFacts {
  switch (event.type) {
    case 'turn/start':
      return { ...INITIAL, turn: event.data.turn }
    case 'user/message': {
      if (state.request !== '' || event.data.source.kind !== 'user') return state
      return { ...state, request: clip(textOf(event.data.content), 400) }
    }
    case 'tool/call':
      return { ...state, open: { ...state.open, [event.data.callId]: { callId: event.data.callId, name: event.data.name, arguments: event.data.arguments } } }
    case 'tool/result': {
      const callId = event.data.message.toolCallId
      const call = state.open[callId]
      if (call === undefined) return state
      const { [callId]: _done, ...open } = state.open
      return { ...state, open, unknown: event.data.error?.code === OUTCOME_UNKNOWN ? [...state.unknown, call] : state.unknown }
    }
    case 'turn/end':
      return { ...state, interrupted: event.data.reason.kind === 'interrupted' }
    default:
      return state
  }
}

function parseInput(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** What the model is told, by class. */
export function resumeText(outcome: Exclude<ResumeOutcome, 'unknown'>, call: string, checkpoint: { readonly id: number, readonly label: string } | undefined): string {
  const head = `The session stopped while \`${call}\` was running, so whether it finished is unknown.`
  const body = {
    read_only: 'It only reads: run it again if you still need its output.',
    idempotent: 'Running it again reaches the same end state either way: you may simply run it again.',
    verify_first: 'It may have partly happened. Check the current state first (what it was meant to create or change), then decide whether to run it again.',
    unsafe: 'Running it again could repeat or worsen its effects. Do not repeat it: inspect what it changed, and tell the user before going on.',
  }[outcome]
  const rewind = checkpoint !== undefined && (outcome === 'verify_first' || outcome === 'unsafe')
    ? `If the files are now in a broken state, the user can put them back to checkpoint #${checkpoint.id} (before "${checkpoint.label}") with /sieve rewind files; suggest it rather than repairing blindly.`
    : ''
  return [head, body, rewind].filter(Boolean).join(' ')
}

export function registerResume(ctx: Context, host: Sieve, runtime: SessionRuntime): void {
  ctx.sessionProjections.register({
    key: RESUME_STATE_KEY,
    stateSchema: z.object({
      turn: z.number(),
      request: z.string(),
      open: z.record(z.string(), z.object({ callId: z.string(), name: z.string(), arguments: z.string() })),
      unknown: z.array(z.object({ callId: z.string(), name: z.string(), arguments: z.string() })),
      interrupted: z.boolean(),
    }),
    stateVersion: 1,
    init: () => INITIAL,
    apply: foldResume,
  })

  const classify = async (agent: Agent, facts: ResumeFacts, call: Call): Promise<void> => {
    const sessionId = agent.session.header.id
    const mode = host.modeOf(resumeSafety.id, sessionId)
    if (mode === 'off') return
    const input = parseInput(call.arguments)
    const line = clip(describeCall(call.name, input), 200)
    const engine = runtime.for(agent)
    const origin = { callId: call.callId, turn: facts.turn }
    let outcome: ResumeOutcome
    // A rule record is written applied already; a judged one is annotated once its notice is out.
    let judged: string | undefined
    if (!isMutatingCall(call.name, input)) {
      // The change rules already know a read: no judge.
      outcome = 'read_only'
      engine.engine.recordRules(resumeSafety, { outcome, state: { call: line }, origin, applied: mode === 'active' })
    } else {
      const decided = await engine.engine.decide(resumeSafety, {
        tool: call.name,
        call: line,
        arguments: clip(call.arguments, MAX_ARGUMENTS),
        changesFiles: true,
        request: facts.request,
      }, { signal: engine.controller.signal, applied: false, origin })
      if (decided.source !== 'judge') return
      outcome = decided.outcome
      judged = decided.ledgerId
    }
    if (outcome === 'unknown' || mode !== 'active') return
    const latest = host.checkpoints?.index?.of(sessionId).checkpoints.at(-1)
    agent.inject(sieveNotice('resume', resumeText(outcome, line, latest), `interrupted call: ${outcome}`))
    if (judged !== undefined) void host.track(host.annotate(sessionId, judged, { applied: true }))
  }

  ctx.on('agent/created', ({ agent, source }) => {
    // A sub-agent's interrupted call is its parent's to sort out; the hive restarts its own bees.
    if (source !== 'resume' || agent.session.header.origin === 'subagent' || host.hive?.isBee(agent) === true) return undefined
    const facts = ctx.sessionProjections.stateOf(agent.session, RESUME_STATE_KEY)
    const call = facts?.interrupted === true ? facts.unknown.at(-1) : undefined
    if (facts === undefined || call === undefined) return undefined
    // Resume must not wait for a judge: the notice reaches the agent's next request.
    void classify(agent, facts, call).catch(() => {
      ctx.logger.warn('sieve: resume classification failed; nothing added')
    })
    return undefined
  })
}
