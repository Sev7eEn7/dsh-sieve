/**
 * Checkpoint index protocol v1: which snapshots belong to which session, in a
 * DSH `ctx.storage` domain, never in the session log. The snapshots
 * themselves live in the shadow repositories under `checkpoint.root`; this is
 * only the list a rewind picks from, the rewinds that happened (with the
 * snapshot that undoes each), and the tree after the agent's last change.
 *
 * Layout: domain `sieve_checkpoints`, table `sessions`, one document per
 * session id. Like the ledger it is bookkeeping: a failed write is logged and
 * dropped, and that turn's checkpoint is not offered.
 * @module
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** Checkpoints and rewinds kept per session, oldest dropped first. */
export const CHECKPOINT_SESSION_CAP = 50
export const REWIND_SESSION_CAP = 20

export type RewindScope = 'both' | 'files' | 'conversation'

/** One per turn that went on to change files. */
export interface CheckpointRecord {
  readonly id: number
  readonly turn: number
  /** The last event before the turn began: a conversation rewind forks the session there. */
  readonly boundarySeq: number
  readonly commit: string
  /** The project folder the snapshot is of. */
  readonly root: string
  readonly label: string
  readonly at: string
}

/** A rewind that happened, or the undoing of one (`to: 'undo'`). */
export interface RewindRecord {
  readonly to: number | 'undo'
  readonly scope: RewindScope
  /** The snapshot taken right before the files went back: what `/sieve rewind undo` restores. */
  readonly undo: string | null
  readonly root: string
  /** The session the conversation went on in. */
  readonly forked: string | null
  readonly at: string
}

/** What the model is told about a rewind, at the session's next step. */
export interface PendingNotice {
  readonly text: string
  readonly summary: string
}

export interface SessionCheckpoints {
  readonly v: 1
  readonly checkpoints: readonly CheckpointRecord[]
  readonly rewinds: readonly RewindRecord[]
  /** The tree right after the agent's last change: what differs from it later somebody else changed. */
  readonly lastTree: string | null
  /**
   * A rewind's notice not yet delivered. DSH clears an agent's step inbox on
   * resume, and a forked session has no live agent, so the notice waits here
   * and goes out with the next step, where the log records it.
   */
  readonly notice: PendingNotice | null
}

const EMPTY: SessionCheckpoints = { v: 1, checkpoints: [], rewinds: [], lastTree: null, notice: null }

const checkpointRecord = z.object({
  id: z.number(),
  turn: z.number(),
  boundarySeq: z.number(),
  commit: z.string(),
  root: z.string(),
  label: z.string(),
  at: z.string(),
})

const rewindRecord = z.object({
  to: z.union([z.number(), z.literal('undo')]),
  scope: z.enum(['both', 'files', 'conversation']),
  undo: z.string().nullable(),
  root: z.string(),
  forked: z.string().nullable(),
  at: z.string(),
})

export const checkpointDomain = defineDomain({
  name: 'sieve_checkpoints',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    sessions: domainTable<string, SessionCheckpoints>(z.object({
      v: z.literal(1),
      checkpoints: z.array(checkpointRecord),
      rewinds: z.array(rewindRecord),
      lastTree: z.string().nullable(),
      notice: z.object({ text: z.string(), summary: z.string() }).nullable(),
    })),
  },
})

export interface IndexLogger {
  warn(message: string): unknown
}

/** Serializes writes per session over one storage table. */
export class CheckpointIndex {
  private readonly table: KvTable<string, SessionCheckpoints>
  private readonly logger: IndexLogger
  private readonly chains = new Map<string, Promise<void>>()

  constructor(table: KvTable<string, SessionCheckpoints>, logger: IndexLogger) {
    this.table = table
    this.logger = logger
  }

  of(sessionId: string): SessionCheckpoints {
    return this.table.get(sessionId) ?? EMPTY
  }

  /** The next checkpoint number of a session. */
  nextId(sessionId: string): number {
    return 1 + Math.max(0, ...this.of(sessionId).checkpoints.map(record => record.id))
  }

  addCheckpoint(sessionId: string, record: CheckpointRecord): Promise<void> {
    return this.update(sessionId, current => ({
      ...current,
      checkpoints: [...current.checkpoints.filter(entry => entry.id !== record.id), record].slice(-CHECKPOINT_SESSION_CAP),
    }))
  }

  addRewind(sessionId: string, record: RewindRecord): Promise<void> {
    return this.update(sessionId, current => ({ ...current, rewinds: [...current.rewinds, record].slice(-REWIND_SESSION_CAP) }))
  }

  setLastTree(sessionId: string, tree: string): Promise<void> {
    if (this.of(sessionId).lastTree === tree) return this.chains.get(sessionId) ?? Promise.resolve()
    return this.update(sessionId, current => ({ ...current, lastTree: tree }))
  }

  setNotice(sessionId: string, notice: PendingNotice | null): Promise<void> {
    return this.update(sessionId, current => ({ ...current, notice }))
  }

  /** A forked session starts with the checkpoints of the history it inherits. */
  seed(sessionId: string, value: SessionCheckpoints): Promise<void> {
    return this.update(sessionId, () => value)
  }

  async drain(): Promise<void> {
    await Promise.all(this.chains.values())
  }

  private update(sessionId: string, change: (current: SessionCheckpoints) => SessionCheckpoints): Promise<void> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(async () => {
      const current = this.table.get(sessionId)
      if (current === undefined) await this.table.put(sessionId, change(EMPTY))
      else await this.table.update(sessionId, change)
    }).catch((error: unknown) => {
      this.logger.warn(`sieve: checkpoint index of session ${sessionId} was not updated: ${String(error)}`)
    })
    this.chains.set(sessionId, next)
    void next.then(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId)
    })
    return next
  }
}
