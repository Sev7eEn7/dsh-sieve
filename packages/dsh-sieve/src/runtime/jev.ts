/**
 * Jev keys in DSH's credential store (`ctx.credentials`). The web panel writes
 * them; an `auto` judge resolves them on every call, as DSH's credential seam
 * intends, so a key saved, replaced or removed reaches the next judgment
 * without a restart. Values never leave the host: callers get presence and
 * source only.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialInfo, CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { JudgeCall, JudgeLike, JudgeResult } from '../judge/judge.ts'
import type { Questions } from '../judge/types.ts'
import type { JevKeyInfo, JevService } from '../status.ts'

export type { JevKeyInfo, JevService }

/** Services that serve Jev over System One, in the order an `auto` judge tries their keys. */
export const JEV_SERVICES: readonly JevService[] = ['typesafe', 'openrouter']

/** The credential reference holding each service's key. */
export const JEV_KEY_REFS: Readonly<Record<JevService, string>> = {
  // TypeSafe's and mu's own name, so a key already exported for mu works as is.
  typesafe: 'TYPESAFE_API_KEY',
  // sieve's own name: a general OpenRouter key kept for model access must not start paid judge calls by itself.
  openrouter: 'SIEVE_JUDGE_OPENROUTER_API_KEY',
}

/** System One endpoint per service; undefined is the provider's default (TypeSafe). */
export const JEV_BASE_URLS: Readonly<Record<JevService, string | undefined>> = {
  typesafe: undefined,
  openrouter: 'https://openrouter.ai/api/v1/systemone',
}

export interface JevKey {
  readonly service: JevService
  readonly apiKey: string
}

export type Credentials = Context['credentials']

/** Why a key could not be stored. */
export class JevKeyError extends Error {
  readonly kind: 'unavailable' | 'read-only'
  constructor(kind: 'unavailable' | 'read-only', message: string) {
    super(message)
    this.name = 'JevKeyError'
    this.kind = kind
  }
}

function refOf(service: JevService): CredentialRef {
  return JEV_KEY_REFS[service] as CredentialRef
}

/**
 * The first service whose key resolves.
 * @param credentials - the store, or undefined when the composition has none.
 * @returns the key and its service, or undefined when none is configured.
 */
export async function resolveJevKey(credentials: Credentials | undefined): Promise<JevKey | undefined> {
  if (credentials === undefined) return undefined
  for (const service of JEV_SERVICES) {
    const resolved = await credentials.resolve(refOf(service))
    if (resolved !== undefined) return { service, apiKey: resolved.value }
  }
  return undefined
}

/**
 * Presence and source of every service's key.
 * @param credentials - the store, or undefined when the composition has none.
 * @returns one entry per service, in resolution order.
 */
export async function describeJevKeys(credentials: Credentials | undefined): Promise<JevKeyInfo[]> {
  return Promise.all(JEV_SERVICES.map(async (service): Promise<JevKeyInfo> => {
    const info: CredentialInfo = credentials === undefined
      ? { configured: false, writable: false }
      : await credentials.describe(refOf(service))
    return { service, ref: JEV_KEY_REFS[service], configured: info.configured, source: info.source ?? null, writable: info.writable }
  }))
}

/**
 * Store or remove one service's key.
 * @param credentials - the store.
 * @param service - whose key.
 * @param apiKey - the key; undefined removes it.
 * @throws {JevKeyError} without a store, or when the reference comes from the process environment.
 */
export async function storeJevKey(credentials: Credentials | undefined, service: JevService, apiKey: string | undefined): Promise<void> {
  if (credentials === undefined) throw new JevKeyError('unavailable', 'no credential store is mounted')
  const ref = refOf(service)
  if (!(await credentials.describe(ref)).writable) {
    throw new JevKeyError('read-only', `${JEV_KEY_REFS[service]} comes from the process environment and cannot be changed here`)
  }
  if (apiKey === undefined) await credentials.unset(ref)
  else await credentials.set(ref, apiKey)
}

export interface JevOrFallbackOptions {
  readonly resolve: () => Promise<JevKey | undefined>
  readonly jev: (key: JevKey) => JudgeLike
  readonly fallback: () => JudgeLike
}

/**
 * Judges with Jev when a key resolves at call time, otherwise with the
 * fallback judge. The result names the judge that actually answered.
 */
export class JevOrFallbackJudge implements JudgeLike {
  readonly id = 'auto'
  private readonly options: JevOrFallbackOptions

  constructor(options: JevOrFallbackOptions) {
    this.options = options
  }

  async evaluate<const Qs extends Questions>(request: JudgeCall<Qs>): Promise<JudgeResult<Qs>> {
    const key = await this.options.resolve()
    return (key === undefined ? this.options.fallback() : this.options.jev(key)).evaluate(request)
  }
}
