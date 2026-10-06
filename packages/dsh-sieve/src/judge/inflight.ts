/**
 * Work still running on behalf of an owner, so the owner can wait for it to
 * settle before it releases what that work uses (the ledger, a reloaded
 * service). A judge returns at its deadline without waiting for a provider
 * that ignores its signal; the provider call stays tracked here.
 * @module
 */

export class Inflight {
  private readonly pending = new Set<Promise<void>>()

  /** Tracks `work` until it settles and returns it unchanged. */
  track<T>(work: Promise<T>): Promise<T> {
    const settled = work.then(() => {}, () => {})
    this.pending.add(settled)
    void settled.then(() => this.pending.delete(settled))
    return work
  }

  get size(): number {
    return this.pending.size
  }

  /** Resolves once everything tracked so far, and anything tracked while waiting, has settled. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending)
  }

  /**
   * Waits for {@link idle} at most `ms`.
   * @returns whether everything settled in time.
   */
  async settle(ms: number): Promise<boolean> {
    if (this.pending.size === 0) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    })
    try {
      return await Promise.race([this.idle().then(() => true as const), expired])
    } finally {
      clearTimeout(timer)
    }
  }
}
