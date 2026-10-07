/**
 * The wire between the panel and the host: two endpoints on Connection's
 * shared `/api` channel, in Connection's RPC envelope, so the browser calls
 * them with `ctx.connection.rpc.call` over whatever carrier the page uses.
 * Payloads are plain JSON; the host validates every field because they
 * arrive from the browser. A Jev key travels browser → host only; no answer
 * carries it back.
 * @module
 */

import type { JevService, SieveJudgeStatus, SieveReduction } from 'dsh-sieve/status'

/** Connection's shared channel; it authenticates every request before an exact route sees it. */
export const API_CHANNEL = '/api'

/** Read the panel view of one session. */
export const PANEL_ENDPOINT = 'sieve/panel'
/** Store or remove one service's Jev key, then read the panel view. */
export const KEY_ENDPOINT = 'sieve/key'

export const ENDPOINTS: readonly string[] = [PANEL_ENDPOINT, KEY_ENDPOINT]

export interface PanelRequest {
  readonly sessionId: string
}

export interface KeyRequest extends PanelRequest {
  readonly service: JevService
  /** The key; null removes the stored one. */
  readonly apiKey: string | null
}

/** Everything the panel shows. */
export interface PanelView {
  readonly v: 3
  /** Whether an agent of the session is loaded on the host; the context size needs one. */
  readonly live: boolean
  readonly reduction: SieveReduction
  readonly judge: SieveJudgeStatus
}

/** The view version this panel reads; a host on another version is reported, not guessed at. */
export const PANEL_VERSION: PanelView['v'] = 3

/** Shortest and longest key accepted; both services issue keys well inside this range. */
export const API_KEY_LENGTH = { min: 8, max: 512 } as const

/** Failure codes these endpoints answer with; the message is for display only. */
export type SieveRpcErrorCode =
  | 'sieve/bad-request'
  | 'sieve/unknown-endpoint'
  | 'sieve/key-unavailable'
  | 'sieve/key-read-only'
  | 'sieve/key-failed'
