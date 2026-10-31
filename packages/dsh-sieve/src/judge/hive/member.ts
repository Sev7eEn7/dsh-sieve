/**
 * Inside a bee. After every step the judge decides whether what the bee said
 * or saw is news for the hive (H1), what each new note does to the earlier
 * ones it speaks about (H3), and which of the others' news matters to this
 * bee (H2). The bee's own model spends nothing on any of it, and never waits
 * for it: steps are judged in order, off its critical path.
 *
 * Ported from mu `packages/kyrn-judge/src/extension/features/hive.ts`
 * (`candidatesOf`, `registerMember`).
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * The gate logic is mu's; how a step's candidates are read and how the
 * inbox reaches the bee is the host's (`src/features/hive/`).
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { DecisionEngine } from '../engine.ts'
import { hiveDeliver, hivePublish, hiveRelate } from '../decisions/hive.ts'
import type { DeliverInput, PublishInput, RelateInput } from '../decisions/hive.ts'
import type { JsonValue } from '../types.ts'
import { isDuplicate, overlapping } from './board.ts'
import type { Board, BoardReader, Note, NoteKind } from './board.ts'
import { conflictLine, correctionLine } from './markers.ts'

/** Flatten whitespace and cut to `length` characters, marking the cut. */
export function clip(text: string, length: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`
}

export interface Candidate {
  readonly text: string
  readonly source: string
}

/** One finished step of a bee, as the host read it from the session. */
export interface StepFacts {
  /** The text the bee wrote in this step. */
  readonly said: string
  readonly calls: readonly { readonly id: string, readonly name: string, readonly arguments: unknown }[]
  readonly results: readonly { readonly callId: string, readonly toolName: string, readonly text: string }[]
}

/** What one step of a bee produced that could be news: what it said, and the beginning of what its tools returned. */
export function candidatesOf(step: StepFacts, limit = 4): Candidate[] {
  const candidates: Candidate[] = []
  const said = step.said.trim()
  if (said.length >= 40) candidates.push({ text: clip(said, 700), source: 'said' })
  const calls = new Map(step.calls.map(call => [call.id, clip(`${call.name} ${JSON.stringify(call.arguments ?? {})}`, 160)]))
  for (const result of step.results) {
    const text = result.text.trim()
    if (text.length < 80) continue
    candidates.push({ text: text.slice(0, 600), source: calls.get(result.callId) ?? result.toolName })
  }
  return candidates.slice(0, limit)
}

function probabilities(values: Readonly<Record<string, number | undefined>>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, number] => entry[1] !== undefined))
}

/** What waits for a bee until its next working step. */
export type InboxItem =
  | { readonly kind: 'note', readonly note: Note, readonly score: number }
  | { readonly kind: 'correction', readonly earlier: Note, readonly later: Note, readonly score: number }
  | { readonly kind: 'conflict', readonly a: Note, readonly b: Note, readonly score: number }

export interface MemberLimits {
  readonly maxNotesPerBee: number
  readonly maxDeliveriesPerBee: number
  /** Earlier notes a new one is held against, at most: the ones sharing the most words with it. */
  readonly maxRelatedPerNote: number
}

export interface HiveContext {
  readonly goal: string
  readonly board: Board
  readonly engine: DecisionEngine
  readonly limits: MemberLimits
  /** No judge: every candidate is posted and handed to every other bee, within the caps (`hive.sharing: broadcast`). */
  readonly broadcast?: boolean | undefined
  /** Stored with each ledger record, e.g. the hive run and the bee. */
  readonly origin?: ((bee: string) => JsonValue) | undefined
  readonly now?: (() => number) | undefined
  readonly newId?: (() => string) | undefined
}

export class HiveMember {
  readonly name: string
  readonly focus: string
  private readonly hive: HiveContext
  private readonly reader: BoardReader
  private readonly seen = new Set<string>()
  /** Notes this bee stands on: its own, and the others' it was handed or is about to be. A correction to one of them reaches it by rule. */
  private readonly holds = new Set<string>()
  private readonly handedOver = new Set<string>()
  private inbox: InboxItem[] = []
  private queue: Promise<void> = Promise.resolve()
  posted = 0
  received = 0

  constructor(name: string, focus: string, hive: HiveContext) {
    this.name = name
    this.focus = focus
    this.hive = hive
    this.reader = hive.board.reader()
  }

  /** What the judge accepted for this bee that it has not been shown yet. */
  get pending(): number {
    return this.inbox.length
  }

  /** Settles when every step queued so far has been judged. */
  get idle(): Promise<void> {
    return this.queue
  }

  /** Queue one step's candidates for the gates. Never rejects: a failed step publishes and delivers nothing. */
  enqueue(candidates: readonly Candidate[], signal?: AbortSignal): Promise<void> {
    this.queue = this.queue.then(() => this.step(candidates, signal)).catch(() => undefined)
    return this.queue
  }

  /** Empties the inbox into lines for the bee, and records each note as delivered: only now has it reached anyone. */
  takeInbox(): string[] {
    const board = this.hive.board
    const replaced = new Set(board.relations().flatMap(row => row.relation === 'supersedes' ? [row.earlier] : []))
    const handed = (note: Note, score: number): void => {
      if (note.bee !== this.name && !this.handedOver.has(note.id)) {
        this.handedOver.add(note.id)
        board.delivered({ note: note.id, to: this.name, score })
      }
      this.holds.add(note.id)
    }
    const lines: string[] = []
    for (const item of this.inbox.splice(0)) {
      if (item.kind === 'note') {
        // Replaced while it waited: the correction goes out in its place, in this same batch or an earlier one.
        if (replaced.has(item.note.id)) {
          board.log({ gate: 'withheld', to: this.name, note: item.note.id, why: 'superseded' })
          continue
        }
        handed(item.note, item.score)
        lines.push(`- ${item.note.bee} (${item.note.kind.replace('_', ' ')}): ${item.note.text}`)
      } else if (item.kind === 'correction') {
        handed(item.later, item.score)
        lines.push(correctionLine(this.called(item.earlier.bee), clip(item.earlier.text, 120), item.later.bee, item.later.text))
      } else {
        handed(item.a, item.score)
        handed(item.b, item.score)
        lines.push(conflictLine(this.called(item.a.bee), clip(item.a.text, 240), this.called(item.b.bee), clip(item.b.text, 240)))
      }
    }
    return lines
  }

  private called(bee: string): string {
    return bee === this.name ? 'you' : bee
  }

  private origin(): JsonValue | undefined {
    return this.hive.origin?.(this.name)
  }

  private now(): string {
    return new Date((this.hive.now ?? Date.now)()).toISOString()
  }

  /** H3: what the notes just posted do to the earlier notes they share words with. */
  private async relate(later: readonly Note[], known: readonly Note[], signal: AbortSignal | undefined): Promise<void> {
    const { board, engine, goal, limits } = this.hive
    const pairs = later.flatMap(note => overlapping(note.text, known, { limit: limits.maxRelatedPerNote }).map(earlier => ({ note, earlier })))
    if (pairs.length === 0) return
    const inputs: RelateInput[] = pairs.map(({ note, earlier }) => ({
      goal,
      earlier: { bee: earlier.bee, kind: earlier.kind, text: earlier.text },
      later: { bee: note.bee, kind: note.kind, text: note.text },
    }))
    const verdicts = await engine.decideMany(hiveRelate, inputs, { signal, origin: this.origin() })
    pairs.forEach(({ note, earlier }, at) => {
      const verdict = verdicts[at]
      if (verdict === undefined) return
      const { relation, score } = verdict.outcome
      // The judge's own reading before the bar, "none" included: what calibrating the bar is done from.
      const answer = verdict.answers?.['relation']
      board.log({
        gate: 'relate',
        by: this.name,
        later: note.id,
        earlier: earlier.id,
        relation,
        score,
        ...(answer?.type === 'choice' ? { choice: answer.choice, ...(answer.probabilities === undefined ? {} : { p: probabilities(answer.probabilities) }) } : {}),
        reason: verdict.reason ?? null,
      })
      if (relation !== null) board.relate({ later: note.id, earlier: earlier.id, relation, score, by: this.name, at: this.now() })
    })
  }

  /**
   * Corrections and disputes reach a bee by rule, on top of the delivery cap:
   * they are about notes it already stands on. The judge is not asked whether
   * a bee wants to hear that what it was told no longer holds.
   */
  private correct(): void {
    const board = this.hive.board
    const rows = this.reader.freshRelations()
    if (rows.length === 0) return
    const byId = new Map(board.all().map(note => [note.id, note]))
    const without = (...ids: string[]): void => {
      this.inbox = this.inbox.filter(item => item.kind !== 'note' || !ids.includes(item.note.id))
    }
    for (const row of rows) {
      const earlier = byId.get(row.earlier)
      const later = byId.get(row.later)
      if (earlier === undefined || later === undefined) continue
      if (row.relation === 'supersedes' && later.bee !== this.name && this.holds.has(earlier.id)) {
        this.seen.add(later.id)
        // The correction carries the later note's words: it is not delivered a second time on its own.
        without(later.id)
        this.inbox.push({ kind: 'correction', earlier, later, score: row.score })
        board.log({ gate: 'correct', to: this.name, note: later.id, replaces: earlier.id, from: later.bee })
      } else if (row.relation === 'contradicts' && (this.holds.has(earlier.id) || this.holds.has(later.id))) {
        this.seen.add(later.id)
        without(earlier.id, later.id)
        this.inbox.push({ kind: 'conflict', a: earlier, b: later, score: row.score })
        board.log({ gate: 'dispute', to: this.name, notes: [earlier.id, later.id] })
      }
    }
  }

  private post(candidate: Candidate, kind: NoteKind, score: number): Note {
    this.posted++
    const id = (this.hive.newId ?? (() => randomUUID().slice(0, 8)))()
    this.seen.add(id)
    this.holds.add(id)
    const note: Note = { id, bee: this.name, kind, score, text: candidate.text, source: candidate.source, at: this.now() }
    this.hive.board.post(note)
    return note
  }

  /** The ablation arm: no gate asks the judge, and nothing is related or corrected. */
  private broadcast(candidates: readonly Candidate[]): void {
    const { board, limits } = this.hive
    const known = board.all()
    for (const candidate of candidates) {
      if (this.posted >= limits.maxNotesPerBee) break
      if (isDuplicate(candidate.text, known)) continue
      board.log({ gate: 'publish', bee: this.name, source: candidate.source, head: clip(candidate.text, 100), text: candidate.text, publish: true, kind: 'finding', score: 1, reason: 'broadcast' })
      this.post(candidate, 'finding', 1)
    }
    const news = this.reader.fresh().filter(note => note.bee !== this.name && !this.seen.has(note.id))
    const room = Math.max(0, limits.maxDeliveriesPerBee - this.received)
    news.forEach((note, at) => {
      this.seen.add(note.id)
      board.log({ gate: 'deliver', to: this.name, from: note.bee, note: note.id, deliver: at < room, score: 1, reason: 'broadcast' })
      if (at >= room) return
      this.received++
      this.inbox.push({ kind: 'note', note, score: 1 })
      this.holds.add(note.id)
    })
  }

  private async step(candidates: readonly Candidate[], signal: AbortSignal | undefined): Promise<void> {
    if (this.hive.broadcast === true) return this.broadcast(candidates)
    const { board, engine, goal, limits } = this.hive
    const known = board.all()
    const novel = candidates.filter(candidate => !isDuplicate(candidate.text, known))
    const mine: Note[] = []
    if (novel.length > 0 && this.posted < limits.maxNotesPerBee) {
      const inputs: PublishInput[] = novel.map(candidate => ({ goal, focus: this.focus, note: candidate.text, source: candidate.source }))
      const verdicts = await engine.decideMany(hivePublish, inputs, { signal, origin: this.origin() })
      verdicts.forEach((verdict, at) => {
        const candidate = novel[at]
        if (candidate === undefined) return
        const { publish, kind, score } = verdict.outcome
        board.log({
          gate: 'publish',
          bee: this.name,
          source: candidate.source,
          head: clip(candidate.text, 100),
          text: candidate.text,
          publish,
          kind,
          score,
          reason: verdict.reason ?? null,
        })
        if (!publish || kind === null || this.posted >= limits.maxNotesPerBee) return
        mine.push(this.post(candidate, kind, score))
      })
    }
    if (mine.length > 0) await this.relate(mine, known, signal)

    const news = this.reader.fresh().filter(note => note.bee !== this.name && !this.seen.has(note.id))
    for (const note of news) this.seen.add(note.id)
    if (news.length > 0 && this.received < limits.maxDeliveriesPerBee) {
      const inputs: DeliverInput[] = news.map(note => ({ focus: this.focus, note: note.text, kind: note.kind, from: note.bee }))
      const verdicts = await engine.decideMany(hiveDeliver, inputs, { signal, origin: this.origin() })
      news.forEach((note, at) => {
        const verdict = verdicts[at]
        board.log({
          gate: 'deliver',
          to: this.name,
          from: note.bee,
          note: note.id,
          deliver: verdict?.outcome.deliver ?? false,
          score: verdict?.outcome.score ?? 0,
          reason: verdict?.reason ?? null,
        })
      })
      const accepted = news
        .map((note, at) => ({ note, verdict: verdicts[at] }))
        .filter(entry => entry.verdict?.outcome.deliver === true)
        .slice(0, limits.maxDeliveriesPerBee - this.received)
      this.received += accepted.length
      // Not handed over here: a note that lands while the bee is writing its report would wake it up again
      // after it had finished, and its last words would replace the report. It gets them at its next step.
      for (const { note, verdict } of accepted) {
        this.inbox.push({ kind: 'note', note, score: verdict?.outcome.score ?? 0 })
        this.holds.add(note.id)
      }
    }
    this.correct()
  }
}
