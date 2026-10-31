/**
 * What a hive hands back: every bee's report, then the board read with its
 * corrections, so the main model can weigh a finding by whether it was
 * confirmed, corrected or disputed. And the live summary the Web panel and
 * `/hive` show while it runs.
 *
 * Ported from mu `packages/kyrn-judge/src/extension/features/hive.ts`
 * (the tool result and `summarizeBoard`).
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * @module
 */

import { foldRelations, pairKey } from './board.ts'
import type { BoardSnapshot, Note, NoteKind } from './board.ts'
import { NO_CHANGE } from './markers.ts'
import { clip } from './member.ts'

/**
 * What a bee hands back, from the messages it ended a turn with. Normally the
 * last one. A bee that was spoken to after it had finished answers with a line
 * or two, and that must not replace the report it gave before; "NO CHANGE" is
 * the answer to a last call, not a report: the one before it stands.
 * From mu `packages/kyrn-judge/src/swarm/state.ts` (`reportOf`).
 */
export function reportOf(finals: readonly string[]): string {
  const unchanged = new RegExp(`^\\W*${NO_CHANGE}\\W*$`, 'i')
  const kept = finals.map(text => text.trim()).filter(text => text !== '' && !unchanged.test(text))
  const last = kept.at(-1)
  if (last === undefined) return ''
  const longest = kept.reduce((best, text) => (text.length > best.length ? text : best), '')
  if (longest === last || longest.length < last.length * 3) return last
  return `${longest}\n\nAdded afterwards:\n${last}`
}

export interface ReportedBee {
  readonly name: string
  /** e.g. "deepseek/deepseek-v4-pro, thinking high". */
  readonly placement: string
  readonly report: string
}

export interface HiveCounts {
  readonly notes: number
  readonly deliveries: number
  readonly corrected: number
  readonly disputes: number
}

export function hiveCounts(board: BoardSnapshot): HiveCounts {
  const state = foldRelations(board.notes, board.relations)
  return { notes: board.notes.length, deliveries: board.deliveries.length, corrected: state.superseded.size, disputes: disputesOf(board).length }
}

/** Unsettled disputes, each pair once. */
export function disputesOf(board: BoardSnapshot): [Note, Note][] {
  const state = foldRelations(board.notes, board.relations)
  const byId = new Map(board.notes.map(note => [note.id, note]))
  const disputes = new Map<string, [Note, Note]>()
  for (const rows of state.contested.values()) {
    for (const row of rows) {
      const a = byId.get(row.earlier)
      const b = byId.get(row.later)
      if (a !== undefined && b !== undefined) disputes.set(pairKey(row.earlier, row.later), [a, b])
    }
  }
  return [...disputes.values()]
}

/** The text the `hive` tool returns. */
export function renderHiveReport(bees: readonly ReportedBee[], board: BoardSnapshot, footer?: string): string {
  const state = foldRelations(board.notes, board.relations)
  const byId = new Map(board.notes.map(note => [note.id, note]))
  const reached = (note: Note) => board.deliveries.filter(delivery => delivery.note === note.id).map(delivery => delivery.to)
  const marks = (note: Note) => {
    const parts: string[] = []
    const confirmed = state.supported.get(note.id)
    if (confirmed !== undefined) parts.push(`confirmed by ${confirmed.join(', ')}`)
    if (state.contested.has(note.id)) parts.push('in dispute')
    return parts.length > 0 ? ` (${parts.join(', ')})` : ''
  }
  const standing = [...state.current].sort((a, b) => b.score - a.score)
  const corrected = [...state.superseded].flatMap(([id, row]) => {
    const earlier = byId.get(id)
    const later = byId.get(row.later)
    return earlier !== undefined && later !== undefined
      ? [`- ${earlier.bee}: "${clip(earlier.text, 160)}" -> ${later.bee}: ${clip(later.text, 300)}`]
      : []
  })
  const disputes = disputesOf(board)
  const sections = [
    standing.length === 0
      ? '(nothing was judged worth sharing)'
      : standing.slice(0, 14).map((note) => {
        const to = reached(note)
        return `- [${note.kind.replace('_', ' ')} ${note.score.toFixed(2)}] ${note.bee}${to.length > 0 ? ` -> ${to.join(', ')}` : ''}${marks(note)}: ${clip(note.text, 400)}`
      }).join('\n'),
    corrected.length > 0 ? `Corrected, no longer standing:\n${corrected.join('\n')}` : '',
    disputes.length > 0
      ? `Unsettled disputes, both sides kept:\n${disputes.map(([a, b]) => `- ${a.bee}: "${clip(a.text, 200)}" vs ${b.bee}: "${clip(b.text, 200)}"`).join('\n')}`
      : '',
  ].filter(section => section !== '')
  const counts = [
    `${board.notes.length} notes passed the judge`,
    corrected.length > 0 ? `${corrected.length} corrected` : '',
    disputes.length > 0 ? `${disputes.length} unsettled` : '',
    `${board.deliveries.length} deliveries between investigators`,
  ].filter(part => part !== '').join(', ')
  return [
    ...bees.map(bee => `## ${bee.name} [${bee.placement}]\n${bee.report}`),
    `## Hive board: ${counts}\n${sections.join('\n')}${footer === undefined ? '' : `\n${footer}`}`,
  ].join('\n\n')
}

export interface BoardSummary {
  readonly notes: number
  readonly deliveries: number
  readonly judged: number
  readonly corrections: number
  readonly conflicts: number
  readonly published: Readonly<Record<string, number>>
  readonly received: Readonly<Record<string, number>>
  readonly latest: readonly {
    readonly at: string
    readonly bee: string
    readonly kind: NoteKind
    readonly score: number
    readonly to: readonly string[]
    readonly text: string
    readonly state?: 'superseded' | 'contested'
  }[]
}

/** The board as the live view shows it. */
export function summarizeBoard(board: BoardSnapshot, latest = 8): BoardSummary {
  const state = foldRelations(board.notes, board.relations)
  const published: Record<string, number> = {}
  const received: Record<string, number> = {}
  for (const note of board.notes) published[note.bee] = (published[note.bee] ?? 0) + 1
  for (const delivery of board.deliveries) received[delivery.to] = (received[delivery.to] ?? 0) + 1
  return {
    notes: board.notes.length,
    deliveries: board.deliveries.length,
    judged: board.judged,
    corrections: state.superseded.size,
    conflicts: disputesOf(board).length,
    published,
    received,
    latest: board.notes.slice(-latest).map(note => ({
      at: note.at,
      bee: note.bee,
      kind: note.kind,
      score: note.score,
      to: board.deliveries.filter(delivery => delivery.note === note.id).map(delivery => delivery.to),
      text: clip(note.text, 200),
      ...(state.superseded.has(note.id) ? { state: 'superseded' as const } : state.contested.has(note.id) ? { state: 'contested' as const } : {}),
    })),
  }
}
