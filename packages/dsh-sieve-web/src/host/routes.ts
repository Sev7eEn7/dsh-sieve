/**
 * The panel endpoints as exact Fetch routes on Connection's shared `/api`
 * channel. Connection admits each request (Host/Origin fence and browser
 * authentication) before an exact route sees it; the route then speaks the
 * same RPC envelope as Connection's own channels, so the browser's generic
 * `rpc.call('/api', endpoint, payload)` reads the answer.
 *
 * Why not `connection.rpc.handle`: at the pinned DSH it registers its Web
 * route through `owner.webServer`, which Cordis resolves against the
 * Connection plugin's own fiber, and that fiber does not inject `webServer`.
 * See notes/implemented/architecture/2026-10-05-web-panel-over-connection-routes.md.
 */
import type { ConnectionFetchRoute, ServerResponse } from '@deepseek-ai/dsh-client-connection'
import { API_CHANNEL, ENDPOINTS } from '../protocol.ts'
import type { SieveEndpoints, SieveRpcResult } from './channel.ts'

function envelope(rpcId: string, result: SieveRpcResult): Response {
  const body: ServerResponse = { type: 'server-response', rpcId: rpcId as ServerResponse['rpcId'], result }
  return Response.json(body)
}

/**
 * One exact POST route per endpoint, mirroring Connection's own envelope
 * checks: JSON only, a `client-request` naming this endpoint.
 * @param answer - the endpoint dispatcher.
 * @returns the routes to register with `connection.fetch`.
 */
export function sieveRoutes(answer: SieveEndpoints): ConnectionFetchRoute[] {
  return ENDPOINTS.map((endpoint): ConnectionFetchRoute => ({
    path: `${API_CHANNEL}/${endpoint}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const media = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (media !== 'application/json') return new Response('content type must be application/json', { status: 415 })
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const message = typeof body === 'object' && body !== null ? body as Readonly<Record<string, unknown>> : {}
      const rpcId = message['rpcId']
      if (message['type'] !== 'client-request' || typeof rpcId !== 'string' || typeof message['method'] !== 'string') {
        return new Response('invalid client-request message', { status: 400 })
      }
      if (message['method'] !== endpoint) {
        return envelope(rpcId, {
          ok: false,
          error: { code: 'sieve/bad-request', message: `method ${JSON.stringify(message['method'])} does not match endpoint ${JSON.stringify(endpoint)}`, details: {} },
        })
      }
      return envelope(rpcId, await answer(endpoint, message['payload']))
    },
  }))
}
