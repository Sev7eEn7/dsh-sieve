/**
 * The hive's shared board. Bees never talk to each other directly; what one
 * of them found reaches the others only through here, and only after the
 * judge let it.
 *
 * Ported from mu `packages/kyrn-judge/src/hive/board.ts`.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * mu's bees are processes sharing append-only files; sieve's run in one
 * process, so the board is in memory, each bee reads it through its own
 * cursor, and the runtime stores `snapshot()` in `ctx.storage`. The pure
 * functions `overlapping`, `foldRelations` and `isDuplicate` are mu's.
 * @module
 */

import type { JsonValue } from '../types.ts'

export type NoteKind = 'finding' | 'dead_end' | 'decision' | 'blocker'

export interface Note {
  readonly id: string
  /** Who posted it. */
  readonly bee: string
  readonly kind: NoteKind
  /** The judge's probability that others need this. */
  readonly score: number
  /** Word for word what the bee said or saw. Nothing is paraphrased on the way. */
  readonly text: string
  /** Where it came from: "said", or the tool call that produced it. */
  readonly source: string
  readonly at: string
}

export interface Delivery {
  readonly note: string
  readonly to: string
  readonly score: number
}

/**
 * What a later note does to an earlier one, as the judge read it. The board
 * only ever grows, so a conclusion that stopped being true would otherwise
 * stay on it as if it still held; these rows are how it is read with its
 * corrections (see `foldRelations`).
 */
export type Relation = 'supersedes' | 'contradicts' | 'supports'

export interface RelationRow {
  readonly later: string
  readonly earlier: string
  readonly relation: Relation
  /** The judge's probability of this reading. */
  readonly score: number
  /** The bee that posted `later`, whose judge asked. */
  readonly by: string
  readonly at: string
}

/** One verdict of the gates, passed or not: the answer to "why did nobody hear about this?". */
export type GateEntry = { readonly at: string, readonly gate: string } & { readonly [key: string]: JsonValue }

/** Everything on a board, as stored and as the Web panel reads it. */
export interface BoardSnapshot {
  readonly notes: readonly Note[]
  readonly deliveries: readonly Delivery[]
  readonly relations: readonly RelationRow[]
  /** The latest gate verdicts, at most `BoardOptions.maxGateEntries`. */
  readonly gates: readonly GateEntry[]
  /** Every gate verdict ever logged, including those no longer kept. */
  readonly judged: number
}

export interface BoardOptions {
  readonly now?: (() => number) | undefined
  /** Gate verdicts kept, newest last; older ones are counted but dropped. */
  readonly maxGateEntries?: number | undefined
}

/** One bee's position in the board: what it has already been handed. */
export interface BoardReader {
  /** Notes posted since the last call. */
  fresh(): Note[]
  /** Relations recorded since the last call. */
  freshRelations(): RelationRow[]
}

export class Board {
  private readonly noteRows: Note[] = []
  private readonly deliveryRows: Delivery[] = []
  private readonly relationRows: RelationRow[] = []
  private readonly gateRows: GateEntry[] = []
  private gateCount = 0
  private readonly now: () => number
  private readonly maxGateEntries: number

  constructor(options: BoardOptions = {}) {
    this.now = options.now ?? Date.now
    this.maxGateEntries = options.maxGateEntries ?? 2000
  }

  post(note: Note): void {
    this.noteRows.push(note)
  }

  all(): Note[] {
    return [...this.noteRows]
  }

  reader(): BoardReader {
    let notes = 0
    let relations = 0
    return {
      fresh: () => {
        const rows = this.noteRows.slice(notes)
        notes = this.noteRows.length
        return rows
      },
      freshRelations: () => {
        const rows = this.relationRows.slice(relations)
        relations = this.relationRows.length
        return rows
      },
    }
  }

  delivered(delivery: Delivery): void {
    this.deliveryRows.push(delivery)
  }

  deliveries(): Delivery[] {
    return [...this.deliveryRows]
  }

  relate(row: RelationRow): void {
    this.relationRows.push(row)
  }

  relations(): RelationRow[] {
    return [...this.relationRows]
  }

  log(entry: { readonly gate: string } & { readonly [key: string]: JsonValue }): void {
    this.gateCount++
    this.gateRows.push({ at: new Date(this.now()).toISOString(), ...entry })
    if (this.gateRows.length > this.maxGateEntries) this.gateRows.splice(0, this.gateRows.length - this.maxGateEntries)
  }

  /** How many verdicts the gates have given so far. */
  judged(): number {
    return this.gateCount
  }

  snapshot(): BoardSnapshot {
    return {
      notes: [...this.noteRows],
      deliveries: [...this.deliveryRows],
      relations: [...this.relationRows],
      gates: [...this.gateRows],
      judged: this.gateCount,
    }
  }
}

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}_./-]{3,}/gu) ?? [])

/**
 * The earlier notes a new one may be speaking about: those it shares enough
 * words with to be worth one question each, the closest first. A rule before
 * the judge, so a board of thirty notes does not cost thirty questions.
 */
export function overlapping<T extends Pick<Note, 'text'>>(
  text: string,
  notes: readonly T[],
  options: { min?: number, shared?: number, limit?: number } = {},
): T[] {
  const { min = 0.15, shared: atLeast = 2, limit = 6 } = options
  const mine = words(text)
  if (mine.size === 0) return []
  const scored: { note: T, overlap: number }[] = []
  for (const note of notes) {
    const theirs = words(note.text)
    if (theirs.size === 0) continue
    let shared = 0
    for (const word of mine) if (theirs.has(word)) shared++
    const overlap = shared / Math.min(mine.size, theirs.size)
    if (shared >= atLeast && overlap >= min) scored.push({ note, overlap })
  }
  return scored
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, limit)
    .map(entry => entry.note)
}

/** The board read with its corrections. */
export interface BoardState {
  /** Notes nothing has replaced, in board order. */
  readonly current: Note[]
  /** Replaced note id → the row that replaced it. */
  readonly superseded: ReadonlyMap<string, RelationRow>
  /** Note id → the rows disputing it, while both sides still stand. */
  readonly contested: ReadonlyMap<string, RelationRow[]>
  /**
   * Note id → the other investigators whose later notes confirmed it, each
   * named once. A bee that says the same thing twice, or builds on what it
   * said before, has not been confirmed by anyone.
   */
  readonly supported: ReadonlyMap<string, readonly string[]>
}

/**
 * What stands, what was replaced by what, and what is in dispute. A replaced
 * note is out; a dispute one side of which was since replaced is over; a
 * dispute nobody settled keeps both sides, because a judge does not get to
 * vote on which of two workers is right.
 */
export function foldRelations(notes: readonly Note[], relations: readonly RelationRow[]): BoardState {
  const ids = new Set(notes.map(note => note.id))
  const known = relations.filter(row => ids.has(row.earlier) && ids.has(row.later))
  const beeOf = new Map(notes.map(note => [note.id, note.bee]))
  const superseded = new Map<string, RelationRow>()
  const supported = new Map<string, string[]>()
  for (const row of known) {
    if (row.relation === 'supersedes') superseded.set(row.earlier, row)
    else if (row.relation === 'supports') {
      const by = beeOf.get(row.later) ?? row.by
      const named = supported.get(row.earlier) ?? []
      if (by !== beeOf.get(row.earlier) && !named.includes(by)) supported.set(row.earlier, [...named, by])
    }
  }
  const contested = new Map<string, RelationRow[]>()
  for (const row of known) {
    if (row.relation !== 'contradicts' || superseded.has(row.earlier) || superseded.has(row.later)) continue
    for (const id of [row.earlier, row.later]) contested.set(id, [...(contested.get(id) ?? []), row])
  }
  return { current: notes.filter(note => !superseded.has(note.id)), superseded, contested, supported }
}

/** Rules before the judge: a note that says what the board already says is not news. */
export function isDuplicate(text: string, notes: readonly Pick<Note, 'text'>[], overlap = 0.8): boolean {
  const mine = words(text)
  if (mine.size === 0) return true
  return notes.some((note) => {
    const theirs = words(note.text)
    let shared = 0
    for (const word of mine) if (theirs.has(word)) shared++
    return shared / mine.size >= overlap
  })
}

/** The unordered key of a pair of notes. */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('+')
}
