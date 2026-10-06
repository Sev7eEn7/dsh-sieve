/** Host side of the panel endpoints: validates browser payloads and answers from the `sieve` service. */
import type { ConnectionRpcFailure, ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type { Sieve } from 'dsh-sieve'
import type { JevService } from 'dsh-sieve/status'
import { API_KEY_LENGTH, KEY_ENDPOINT, PANEL_ENDPOINT, PANEL_VERSION } from '../protocol.ts'
import type { KeyRequest, PanelRequest, PanelView, SieveRpcErrorCode } from '../protocol.ts'

/** What the endpoints use of the sieve service. */
export type SieveFacade = Pick<Sieve, 'status' | 'judgeStatus' | 'setJevKey'>

type SessionKey = Parameters<Sieve['status']>[0]

/** One endpoint's answer, before Connection's envelope wraps it. */
export type SieveRpcResult = ConnectionRpcResult<unknown>

/** Answers one endpoint call. */
export type SieveEndpoints = (endpoint: string, payload: unknown) => Promise<SieveRpcResult>

/** Longest session id accepted; DSH ids are far shorter. */
const MAX_SESSION_ID = 256

function failure(code: SieveRpcErrorCode, message: string, details: object = {}): SieveRpcResult {
  const error: ConnectionRpcFailure = { code, message, details }
  return { ok: false, error }
}

function isFailure(value: object): value is SieveRpcResult {
  return 'ok' in value
}

function record(payload: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Readonly<Record<string, unknown>>
    : undefined
}

function parsePanel(body: Readonly<Record<string, unknown>> | undefined): PanelRequest | SieveRpcResult {
  if (body === undefined) return failure('sieve/bad-request', 'payload must be an object')
  const sessionId = body['sessionId']
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID) {
    return failure('sieve/bad-request', 'sessionId must be a nonempty string', { field: 'sessionId' })
  }
  return { sessionId }
}

function parseKey(body: Readonly<Record<string, unknown>> | undefined, services: readonly JevService[]): KeyRequest | SieveRpcResult {
  const panel = parsePanel(body)
  if (isFailure(panel)) return panel
  const service = services.find(candidate => candidate === body?.['service'])
  if (service === undefined) return failure('sieve/bad-request', `service must be one of ${services.join(', ')}`, { field: 'service' })
  const apiKey = body?.['apiKey']
  if (apiKey === null) return { ...panel, service, apiKey }
  if (typeof apiKey !== 'string' || apiKey.length < API_KEY_LENGTH.min || apiKey.length > API_KEY_LENGTH.max || !/^\S+$/.test(apiKey)) {
    // The message never echoes what was sent.
    return failure('sieve/bad-request', `apiKey must be ${API_KEY_LENGTH.min} to ${API_KEY_LENGTH.max} characters without spaces, or null`, { field: 'apiKey' })
  }
  return { ...panel, service, apiKey }
}

async function view(sieve: SieveFacade, sessionId: string): Promise<PanelView> {
  const status = sieve.status(sessionId as SessionKey, { recent: 0 })
  return { v: PANEL_VERSION, live: status.live, reduction: status.reduction, judge: await sieve.judgeStatus() }
}

function keyFailure(error: unknown): SieveRpcResult {
  const kind = typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'JevKeyError'
    ? (error as { kind?: unknown }).kind
    : undefined
  const message = error instanceof Error ? error.message : String(error)
  if (kind === 'unavailable') return failure('sieve/key-unavailable', message)
  if (kind === 'read-only') return failure('sieve/key-read-only', message)
  return failure('sieve/key-failed', message)
}

/**
 * Answer the panel's endpoints.
 * @param sieve - the `sieve` service.
 * @returns the endpoint dispatcher.
 */
export function sieveEndpoints(sieve: SieveFacade): SieveEndpoints {
  return async (endpoint, payload) => {
    if (endpoint === PANEL_ENDPOINT) {
      const request = parsePanel(record(payload))
      if (isFailure(request)) return request
      return { ok: true, value: await view(sieve, request.sessionId) }
    }
    if (endpoint === KEY_ENDPOINT) {
      const services = (await sieve.judgeStatus()).keys.map(key => key.service)
      const request = parseKey(record(payload), services)
      if (isFailure(request)) return request
      try {
        await sieve.setJevKey(request.service, request.apiKey ?? undefined)
      } catch (error) {
        return keyFailure(error)
      }
      return { ok: true, value: await view(sieve, request.sessionId) }
    }
    return failure('sieve/unknown-endpoint', `unknown endpoint ${JSON.stringify(endpoint)}`)
  }
}
