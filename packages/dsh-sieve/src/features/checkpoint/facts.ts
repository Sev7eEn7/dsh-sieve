/**
 * What checkpoints know about the current turn, folded from the native log as
 * a host-only session projection: where the turn began (a conversation
 * rewind keeps everything before it), what it is called, and how its tool
 * calls went (the facts `turn.rewind` is asked with).
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { clip } from '../../judge/hive/member.ts'
import { commandOf, isCheckCommand, isFileWriteTool, isShellTool, runFailed } from '../../judge/monitor/mutating.ts'
import { textOf } from '../../runtime/session-state.ts'
import { describeCall } from '../admission-rules.ts'

export const CHECKPOINT_STATE_KEY = 'sieve/checkpoint'

const MAX_STEPS = 12
const MAX_COMMAND = 200
const MAX_LABEL = 60

interface PendingCall {
  readonly action: string
  readonly command: string | null
  readonly writes: boolean
}

export interface TurnFacts {
  readonly turn: number
  /** The `turn/start` seq; -1 before the first turn. */
  readonly startSeq: number
  /** The turn's first message, clipped: what its checkpoint is called. */
  readonly label: string
  readonly pending: Readonly<Record<string, PendingCall>>
  /** This turn's latest tool calls with their outcome, oldest first. */
  readonly steps: string[]
  /** File writes in this turn. */
  readonly edits: number
  /** Whether the latest test, build or lint run of this turn failed; null when none ran. */
  readonly lastCheckFailed: boolean | null
  /** Shell commands that failed in this turn, and how often. */
  readonly failures: Readonly<Record<string, number>>
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'sieve/checkpoint': TurnFacts
    /** The team supervisor's copy: what a member did in the turn it completed a task. */
    'sieve/team-steps': TurnFacts
  }
}

const INITIAL: TurnFacts = { turn: 0, startSeq: -1, label: '', pending: {}, steps: [], edits: 0, lastCheckFailed: null, failures: {} }

function parseInput(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export function foldTurnFacts(state: TurnFacts, event: SessionEvent): TurnFacts {
  switch (event.type) {
    case 'turn/start':
      return { ...INITIAL, turn: event.data.turn, startSeq: event.seq }
    case 'user/message': {
      if (state.label !== '' || state.startSeq < 0) return state
      const text = textOf(event.data.content).replace(/\s+/g, ' ').trim()
      return text === '' ? state : { ...state, label: clip(text, MAX_LABEL) }
    }
    case 'tool/call': {
      const input = parseInput(event.data.arguments)
      const command = isShellTool(event.data.name) ? commandOf(input) : null
      const call: PendingCall = {
        action: describeCall(event.data.name, input),
        command: command === null ? null : command.slice(0, MAX_COMMAND),
        writes: isFileWriteTool(event.data.name),
      }
      return { ...state, pending: { ...state.pending, [event.data.callId]: call } }
    }
    case 'tool/result': {
      const message = event.data.message
      const call = state.pending[message.toolCallId]
      if (call === undefined) return state
      const { [message.toolCallId]: _done, ...pending } = state.pending
      const failed = call.command !== null ? runFailed(textOf(message.content), message.isError === true) : message.isError === true
      let next: TurnFacts = {
        ...state,
        pending,
        steps: [...state.steps, `${call.action} -> ${failed ? 'failed' : 'ok'}`].slice(-MAX_STEPS),
        edits: state.edits + (call.writes && message.isError !== true ? 1 : 0),
      }
      if (call.command !== null && isCheckCommand(call.command)) next = { ...next, lastCheckFailed: failed }
      if (call.command !== null && failed) next = { ...next, failures: { ...next.failures, [call.command]: (next.failures[call.command] ?? 0) + 1 } }
      return next
    }
    default:
      return state
  }
}

/** `key`: the checkpoint's own, or another feature's copy of the same facts. */
export function registerTurnFacts(ctx: Context, key: typeof CHECKPOINT_STATE_KEY | 'sieve/team-steps' = CHECKPOINT_STATE_KEY): void {
  ctx.sessionProjections.register({
    key,
    stateSchema: z.object({
      turn: z.number(),
      startSeq: z.number(),
      label: z.string(),
      pending: z.record(z.string(), z.object({ action: z.string(), command: z.string().nullable(), writes: z.boolean() })),
      steps: z.array(z.string()),
      edits: z.number(),
      lastCheckFailed: z.boolean().nullable(),
      failures: z.record(z.string(), z.number()),
    }),
    stateVersion: 1,
    init: () => INITIAL,
    apply: foldTurnFacts,
  })
}
