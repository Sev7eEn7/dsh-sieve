/**
 * What the monitor knows about an agent's work, folded from the native log
 * as a host-only session projection, so resume and fork rebuild it: which
 * files a turn wrote, which writes nothing ran after, the last check and
 * whether it failed, the recent actions and how many results in a row ended
 * the same way.
 *
 * A real user message starts a new request: the actions and the repeat run
 * start over. A goal's automatic rounds (`goal` messages) do not, so a loop
 * that spans rounds still counts.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { commandOf, isCheckCommand, isFileWriteTool, isReadOnlyCommand, isShellTool, runFailed } from '../../judge/monitor/mutating.ts'
import { describeCall } from '../admission-rules.ts'
import { textOf } from '../../runtime/session-state.ts'

export const MONITOR_STATE_KEY = 'sieve/monitor'

/** Actions kept for the drift check; it reads the latest `monitor.window` of them. */
const MAX_ACTIONS = 32
const MAX_COMMAND = 200

interface PendingCall {
  readonly action: string
  /** The file a file tool writes. */
  readonly writes: string | null
  /** A shell call's command. */
  readonly command: string | null
  /** A shell command that runs something rather than only reading. */
  readonly runs: boolean
}

export interface MonitorFacts {
  readonly turn: number
  /** Files a file tool wrote in this turn. */
  readonly edited: string[]
  /** Files written since the last command that ran something, across turns. */
  readonly unverified: string[]
  readonly lastCheck: { readonly command: string, readonly failed: boolean, readonly turn: number } | null
  /** Calls whose result has not come yet, by call id. */
  readonly pending: Readonly<Record<string, PendingCall>>
  /** Since the user's last request, newest last: `bash: npm test -> ok`. */
  readonly actions: string[]
  /** Tool results since the user's last request. */
  readonly results: number
  /** How many results in a row were the same call ending the same way, with the same output. */
  readonly repeat: { readonly signature: string, readonly action: string, readonly count: number } | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'sieve/monitor': MonitorFacts
  }
}

const INITIAL: MonitorFacts = { turn: 0, edited: [], unverified: [], lastCheck: null, pending: {}, actions: [], results: 0, repeat: null }

function parseInput(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function pathOf(input: Readonly<Record<string, unknown>>): string {
  const value = input['path'] ?? input['file_path']
  return typeof value === 'string' && value !== '' ? value : '?'
}

/** FNV-1a: enough to tell two outputs apart, stable across runs. */
function digest(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

const add = (list: string[], item: string): string[] => list.includes(item) ? list : [...list, item]

export function foldFacts(state: MonitorFacts, event: SessionEvent): MonitorFacts {
  switch (event.type) {
    case 'user/message':
      return event.data.source.kind === 'user' ? { ...state, actions: [], results: 0, repeat: null } : state
    case 'turn/start':
      return { ...state, turn: event.data.turn, edited: [], pending: {} }
    case 'tool/call': {
      const input = parseInput(event.data.arguments)
      const shell = isShellTool(event.data.name)
      const command = shell ? commandOf(input) : null
      const call: PendingCall = {
        action: describeCall(event.data.name, input),
        writes: isFileWriteTool(event.data.name) ? pathOf(input) : null,
        command,
        runs: command !== null && !isReadOnlyCommand(command, event.data.name === 'pwsh'),
      }
      return { ...state, pending: { ...state.pending, [event.data.callId]: call } }
    }
    case 'tool/result': {
      const message = event.data.message
      const call = state.pending[message.toolCallId]
      if (call === undefined) return state
      const { [message.toolCallId]: _done, ...pending } = state.pending
      const text = textOf(message.content)
      let next: MonitorFacts = { ...state, pending }
      if (call.writes !== null && !message.isError) {
        next = { ...next, edited: add(next.edited, call.writes), unverified: add(next.unverified, call.writes) }
      }
      if (call.runs) next = { ...next, unverified: [] }
      if (call.command !== null && isCheckCommand(call.command)) {
        next = { ...next, lastCheck: { command: call.command.slice(0, MAX_COMMAND), failed: runFailed(text, message.isError === true), turn: state.turn } }
      }
      const action = `${call.action} -> ${message.isError === true ? 'error' : 'ok'}`
      const signature = `${action}#${digest(text)}`
      const count = next.repeat?.signature === signature ? next.repeat.count + 1 : 1
      return { ...next, actions: [...next.actions, action].slice(-MAX_ACTIONS), results: next.results + 1, repeat: { signature, action, count } }
    }
    default:
      return state
  }
}

const pendingSchema = z.object({ action: z.string(), writes: z.string().nullable(), command: z.string().nullable(), runs: z.boolean() })

export function registerMonitorFacts(ctx: Context): void {
  ctx.sessionProjections.register({
    key: MONITOR_STATE_KEY,
    stateSchema: z.object({
      turn: z.number(),
      edited: z.array(z.string()),
      unverified: z.array(z.string()),
      lastCheck: z.object({ command: z.string(), failed: z.boolean(), turn: z.number() }).nullable(),
      pending: z.record(z.string(), pendingSchema),
      actions: z.array(z.string()),
      results: z.number(),
      repeat: z.object({ signature: z.string(), action: z.string(), count: z.number() }).nullable(),
    }),
    stateVersion: 1,
    init: () => INITIAL,
    apply: foldFacts,
  })
}
