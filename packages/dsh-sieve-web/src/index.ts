/**
 * dsh-sieve-web, Host half: answers the panel on Connection's authenticated
 * `/api` channel with a session's context reduction and the judge's Jev keys,
 * and stores or removes those keys in DSH's credential store. The browser
 * half is `./client`, discovered by DSH Client Modules from `dsh.client`.
 *
 * `connection` exists only in Web compositions; in a headless profile this
 * plugin stays pending and dsh-sieve runs unchanged.
 * @module dsh-sieve-web
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type {} from 'dsh-sieve'
import { sieveEndpoints } from './host/channel.ts'
import { sieveRoutes } from './host/routes.ts'

export const name = 'sieve-web'
export const inject = ['sieve', 'connection']

/**
 * The Host Connection face. Its package declares no `Context` member for it,
 * so it is read by name, as DSH's own Session-log export route does.
 */
function connectionOf(ctx: Context): Pick<HostConnectionHandle, 'fetch'> {
  return Reflect.get(ctx, 'connection') as Pick<HostConnectionHandle, 'fetch'>
}

/**
 * Register the panel routes; Connection removes them with this plugin.
 * @param ctx - plugin context with `sieve` and `connection`.
 */
export function apply(ctx: Context): void {
  const connection = connectionOf(ctx)
  for (const route of sieveRoutes(sieveEndpoints(ctx.sieve))) connection.fetch.register(route)
}
