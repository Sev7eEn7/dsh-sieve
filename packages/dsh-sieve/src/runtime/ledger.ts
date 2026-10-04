/**
 * Ledger storage protocol v1: judged decisions per session in a DSH
 * `ctx.storage` domain, never in the session log (custom session events make
 * a session unresumable, see notes/implemented/architecture/
 * 2026-10-03-no-custom-session-events.md). The ledger is bookkeeping: a write
 * that fails is logged and dropped, and never changes a decision.
 *
 * Layout: domain `sieve_ledger`, table `sessions`, one document per session id
 * holding that session's latest records, oldest dropped past the cap. Records
 * are disposable derived data, so an unreadable document is backed up and
 * skipped rather than failing the open.
 * @module
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { LedgerRecord } from '../judge/ledger.ts'

/** Records kept per session; older ones are dropped first. */
export const LEDGER_SESSION_CAP = 1000

export interface SessionLedger {
  readonly records: readonly LedgerRecord[]
}

const ledgerRecord = z.custom<LedgerRecord>(
  value => typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string',
)

const sessionLedger = z.object({ records: z.array(ledgerRecord) })

export const ledgerDomain = defineDomain({
  name: 'sieve_ledger',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { sessions: domainTable<string, SessionLedger>(sessionLedger) },
})

/** Where a failed write is reported; `ctx.logger` in production. */
export interface LedgerLogger {
  warn(message: string): unknown
}

/** Serializes writes per session over one storage table. */
export class SessionLedgers {
  private readonly table: KvTable<string, SessionLedger>
  private readonly logger: LedgerLogger
  private readonly cap: number
  private readonly chains = new Map<string, Promise<void>>()

  constructor(table: KvTable<string, SessionLedger>, logger: LedgerLogger, cap = LEDGER_SESSION_CAP) {
    this.table = table
    this.logger = logger
    this.cap = cap
  }

  /** The session's records, oldest first. */
  records(sessionId: string): readonly LedgerRecord[] {
    return this.table.get(sessionId)?.records ?? []
  }

  /** Queue one record; resolves when it is stored or its failure is logged. */
  append(sessionId: string, record: LedgerRecord): Promise<void> {
    return this.enqueue(sessionId, async () => {
      if (this.table.get(sessionId) === undefined) await this.table.put(sessionId, { records: [record] })
      else await this.table.update(sessionId, current => ({ records: [...current.records, record].slice(-this.cap) }))
    })
  }

  /** Record whether the host acted on a decision, once it knows (an archive write can still fail after a verdict). */
  markApplied(sessionId: string, recordId: string, applied: boolean): Promise<void> {
    return this.enqueue(sessionId, async () => {
      if (this.table.get(sessionId) === undefined) return
      await this.table.update(sessionId, current => ({
        records: current.records.map(record => (record.id === recordId ? { ...record, applied } : record)),
      }))
    })
  }

  /** Wait for every queued write. */
  async drain(): Promise<void> {
    await Promise.all(this.chains.values())
  }

  private enqueue(sessionId: string, write: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(write).catch((error: unknown) => {
      this.logger.warn(`sieve: ledger write for session ${sessionId} failed: ${String(error)}`)
    })
    this.chains.set(sessionId, next)
    void next.then(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId)
    })
    return next
  }
}
