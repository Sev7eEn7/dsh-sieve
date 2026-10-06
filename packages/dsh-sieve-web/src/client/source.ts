/** One session's panel state behind a bare observable, fed by the panel endpoints. */
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection/client'
import type { JevService } from 'dsh-sieve/status'
import { KEY_ENDPOINT, PANEL_ENDPOINT, PANEL_VERSION } from '../protocol.ts'
import type { KeyRequest, PanelRequest, PanelView } from '../protocol.ts'

/** Why the panel has no fresh view. Copy is chosen by the component. */
export type PanelError =
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  | { readonly kind: 'version' }

export interface PanelState {
  /** The last view read; kept while a later read fails so the panel does not blank. */
  readonly view: PanelView | undefined
  readonly loading: boolean
  readonly error: PanelError | undefined
  /** The service whose key is being stored or removed. */
  readonly saving: JevService | undefined
}

/** One call on the channel, already bound to it. */
export type ChannelCall = (endpoint: string, payload: PanelRequest | KeyRequest, signal: AbortSignal) => Promise<ConnectionRpcResult<unknown>>

const INITIAL: PanelState = { view: undefined, loading: false, error: undefined, saving: undefined }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isView(value: unknown): value is PanelView {
  return typeof value === 'object' && value !== null && (value as { v?: unknown }).v === PANEL_VERSION
    && typeof (value as { reduction?: unknown }).reduction === 'object'
}

/**
 * Reads are coalesced while one is in flight, and an answer older than one
 * already shown is dropped, so a slow read cannot undo a key change.
 */
export class PanelSource {
  private snapshot: PanelState = INITIAL
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private inflight: Promise<boolean> | undefined
  private issued = 0
  private shown = 0
  private readonly sessionId: string
  private readonly call: ChannelCall

  constructor(sessionId: string, call: ChannelCall) {
    this.sessionId = sessionId
    this.call = call
  }

  getSnapshot(): PanelState {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Whether anything has asked for this session yet; a reconnect only re-reads those. */
  get started(): boolean {
    return this.issued > 0
  }

  async refresh(): Promise<void> {
    if (this.lifetime.signal.aborted) return
    this.inflight ??= this.request(PANEL_ENDPOINT, { sessionId: this.sessionId })
      .finally(() => { this.inflight = undefined })
    await this.inflight
  }

  /**
   * Store one service's key, or remove it with null.
   * @returns whether the host accepted it, so the caller can clear its draft.
   */
  async setKey(service: JevService, apiKey: string | null): Promise<boolean> {
    if (this.lifetime.signal.aborted || this.snapshot.saving !== undefined) return false
    this.publish({ ...this.snapshot, saving: service })
    try {
      return await this.request(KEY_ENDPOINT, { sessionId: this.sessionId, service, apiKey })
    } finally {
      if (!this.lifetime.signal.aborted) this.publish({ ...this.snapshot, saving: undefined })
    }
  }

  /** Abort what is in flight; later answers are ignored. */
  dispose(): void {
    this.lifetime.abort()
    this.listeners.clear()
  }

  private async request(endpoint: string, payload: PanelRequest | KeyRequest): Promise<boolean> {
    const sequence = ++this.issued
    this.publish({ ...this.snapshot, loading: true })
    let next: Pick<PanelState, 'view' | 'error'>
    try {
      const result = await this.call(endpoint, payload, this.lifetime.signal)
      if (!result.ok) next = { view: this.snapshot.view, error: { kind: 'rejected', code: result.error.code, message: result.error.message } }
      else if (!isView(result.value)) next = { view: this.snapshot.view, error: { kind: 'version' } }
      else next = { view: result.value, error: undefined }
    } catch (error: unknown) {
      if (this.lifetime.signal.aborted) return false
      next = { view: this.snapshot.view, error: { kind: 'unavailable', message: messageOf(error) } }
    }
    // A newer answer is already shown; the newest request still owns `loading`.
    if (this.lifetime.signal.aborted || sequence < this.shown) return next.error === undefined
    this.shown = sequence
    this.publish({ ...this.snapshot, ...next, loading: sequence !== this.issued })
    return next.error === undefined
  }

  private publish(next: PanelState): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
