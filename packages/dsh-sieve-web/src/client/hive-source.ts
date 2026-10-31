/** One session's hives behind a bare observable, fed by the hive endpoint. */
import type { SieveHiveView } from 'dsh-sieve/status'
import { HIVE_ENDPOINT, HIVE_VERSION } from '../protocol.ts'
import type { ChannelCall, PanelError } from './source.ts'

export interface HiveState {
  /** The last view read; kept while a later read fails so the page does not blank. */
  readonly view: SieveHiveView | undefined
  readonly loading: boolean
  readonly error: PanelError | undefined
}

const INITIAL: HiveState = { view: undefined, loading: false, error: undefined }

function isView(value: unknown): value is SieveHiveView {
  return typeof value === 'object' && value !== null && (value as { v?: unknown }).v === HIVE_VERSION
    && Array.isArray((value as { runs?: unknown }).runs)
}

/** Reads are coalesced while one is in flight; nothing is written from here. */
export class HiveSource {
  private snapshot: HiveState = INITIAL
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private inflight: Promise<void> | undefined
  private issued = 0
  private readonly sessionId: string
  private readonly call: ChannelCall

  constructor(sessionId: string, call: ChannelCall) {
    this.sessionId = sessionId
    this.call = call
  }

  getSnapshot(): HiveState {
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
    this.inflight ??= this.read().finally(() => { this.inflight = undefined })
    await this.inflight
  }

  /** Abort what is in flight; later answers are ignored. */
  dispose(): void {
    this.lifetime.abort()
    this.listeners.clear()
  }

  private async read(): Promise<void> {
    this.issued++
    this.publish({ ...this.snapshot, loading: true })
    let next: Pick<HiveState, 'view' | 'error'>
    try {
      const result = await this.call(HIVE_ENDPOINT, { sessionId: this.sessionId }, this.lifetime.signal)
      if (!result.ok) next = { view: this.snapshot.view, error: { kind: 'rejected', code: result.error.code, message: result.error.message } }
      else if (!isView(result.value)) next = { view: this.snapshot.view, error: { kind: 'version' } }
      else next = { view: result.value, error: undefined }
    } catch (error: unknown) {
      if (this.lifetime.signal.aborted) return
      next = { view: this.snapshot.view, error: { kind: 'unavailable', message: error instanceof Error ? error.message : String(error) } }
    }
    if (this.lifetime.signal.aborted) return
    this.publish({ ...next, loading: false })
  }

  private publish(next: HiveState): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
