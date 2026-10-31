/**
 * Hive storage protocol v1: each session's finished hive runs in a DSH
 * `ctx.storage` domain, never in the session log. A run is what the Web panel
 * and `/hive` show after the fact: who ran on which model, how it ended, and
 * the board with every gate verdict. Like the ledger it is bookkeeping: a
 * failed write is logged and dropped.
 *
 * Layout: domain `sieve_hive`, table `sessions`, one document per parent
 * session id holding its latest runs, oldest dropped past the cap.
 * @module
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { BoardSnapshot } from '../../judge/hive/board.ts'
import type { SieveBeeStatus } from '../../status.ts'

/** Runs kept per session. */
export const HIVE_SESSION_CAP = 10

export type BeeStatus = SieveBeeStatus

export interface HiveBeeRecord {
  readonly name: string
  readonly focus: string
  readonly childId: string
  /** e.g. "deepseek/deepseek-v4-flash, thinking low", or "parent model". */
  readonly placement: string
  readonly status: BeeStatus
  readonly verifier: boolean
  /** Its last words before the report, while it runs; its report once it ended. */
  readonly said: string
  readonly startedAt: string | null
  readonly endedAt: string | null
}

export interface HiveRunRecord {
  readonly v: 1
  readonly id: string
  readonly sessionId: string
  /** The tool call that started it. */
  readonly callId: string
  readonly goal: string
  readonly status: 'running' | 'done' | 'cancelled'
  readonly startedAt: string
  readonly endedAt: string | null
  readonly bees: readonly HiveBeeRecord[]
  readonly board: BoardSnapshot
  /** Why some bees never ran, e.g. the subagent capacity was used up. */
  readonly notes: readonly string[]
}

export interface SessionHiveRuns {
  readonly runs: readonly HiveRunRecord[]
}

const runRecord = z.custom<HiveRunRecord>(
  value => typeof value === 'object' && value !== null && (value as { v?: unknown }).v === 1 && typeof (value as { id?: unknown }).id === 'string',
)

export const hiveDomain = defineDomain({
  name: 'sieve_hive',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { sessions: domainTable<string, SessionHiveRuns>(z.object({ runs: z.array(runRecord) })) },
})

export interface HiveStoreLogger {
  warn(message: string): unknown
}

/** Serializes writes per session over one storage table. */
export class HiveStore {
  private readonly table: KvTable<string, SessionHiveRuns>
  private readonly logger: HiveStoreLogger
  private readonly chains = new Map<string, Promise<void>>()

  constructor(table: KvTable<string, SessionHiveRuns>, logger: HiveStoreLogger) {
    this.table = table
    this.logger = logger
  }

  runs(sessionId: string): readonly HiveRunRecord[] {
    return this.table.get(sessionId)?.runs ?? []
  }

  /** Store a run, replacing an earlier record of the same id. */
  save(record: HiveRunRecord): Promise<void> {
    const sessionId = record.sessionId
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(async () => {
      if (this.table.get(sessionId) === undefined) await this.table.put(sessionId, { runs: [record] })
      else {
        await this.table.update(sessionId, current => ({
          runs: [...current.runs.filter(run => run.id !== record.id), record].slice(-HIVE_SESSION_CAP),
        }))
      }
    }).catch((error: unknown) => {
      this.logger.warn(`sieve: hive run ${record.id} for session ${sessionId} was not stored: ${String(error)}`)
    })
    this.chains.set(sessionId, next)
    void next.then(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId)
    })
    return next
  }

  async drain(): Promise<void> {
    await Promise.all(this.chains.values())
  }
}
