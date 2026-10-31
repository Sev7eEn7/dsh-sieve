/**
 * A session's hives as the Web panel reads them: bees with what they sent and
 * received, the lines of the map, the latest deliveries and gate verdicts.
 * Built on the host from the stored runs, so the browser draws without
 * knowing how a board folds.
 *
 * `hiveLinks` is ported from mu
 * `desktop/packages/desktop/src/renderer/pages/conversation/KyrnPanel/Hive/Graph/links.ts`.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * @module
 */

import type { JsonValue } from '../../judge/types.ts'
import type { BoardSnapshot, GateEntry, Note } from '../../judge/hive/board.ts'
import { clip } from '../../judge/hive/member.ts'
import { summarizeBoard } from '../../judge/hive/report.ts'
import type { SieveHiveDelivery, SieveHiveLink, SieveHiveRun, SieveHiveVerdict, SieveHiveView } from '../../status.ts'
import type { HiveRunRecord } from './store.ts'

export const HIVE_VIEW_VERSION: SieveHiveView['v'] = 1
const LATEST_DELIVERIES = 40
const LATEST_VERDICTS = 60
const LINE_TEXT = 200

type Row = { readonly kind: SieveHiveLink['kind'], readonly from: string, readonly to: string, readonly text: string }

function fold(rows: readonly Row[]): SieveHiveLink[] {
  const links = new Map<string, { kind: SieveHiveLink['kind'], from: string, to: string, count: number, texts: string[] }>()
  for (const row of rows) {
    if (row.from === '' || row.to === '' || row.from === row.to) continue
    const key = JSON.stringify([row.kind, row.from, row.to])
    const link = links.get(key) ?? { kind: row.kind, from: row.from, to: row.to, count: 0, texts: [] }
    link.count += 1
    if (row.text !== '') link.texts = [...link.texts, clip(row.text, LINE_TEXT)].slice(-3)
    links.set(key, link)
  }
  return [...links.values()]
}

/**
 * A run's lines, deliveries first so corrections and disputes draw on top. A
 * relation whose notes are not on the board draws nothing; a dispute over a
 * note that was later superseded is settled by that correction and is not
 * drawn.
 */
export function hiveLinks(board: BoardSnapshot): SieveHiveLink[] {
  const byId = new Map(board.notes.map(note => [note.id, note]))
  const superseded = new Set(board.relations.filter(row => row.relation === 'supersedes').map(row => row.earlier))
  const disputed = new Set<string>()
  const rows: Row[] = board.deliveries.flatMap((delivery) => {
    const note = byId.get(delivery.note)
    return note === undefined ? [] : [{ kind: 'delivery' as const, from: note.bee, to: delivery.to, text: note.text }]
  })
  for (const row of board.relations) {
    const later = byId.get(row.later)
    const earlier = byId.get(row.earlier)
    if (later === undefined || earlier === undefined || row.relation === 'supports') continue
    if (row.relation === 'supersedes') {
      rows.push({ kind: 'correction', from: later.bee, to: earlier.bee, text: later.text })
    } else if (!superseded.has(row.earlier) && !superseded.has(row.later)) {
      const pair = [row.earlier, row.later].sort().join('+')
      if (disputed.has(pair)) continue
      disputed.add(pair)
      // A dispute has no direction: the pair is written the same way whichever note came second.
      const [from, to] = [earlier.bee, later.bee].sort() as [string, string]
      rows.push({ kind: 'conflict', from, to, text: later.text })
    }
  }
  const order: Record<SieveHiveLink['kind'], number> = { delivery: 0, correction: 1, conflict: 2 }
  return fold(rows).sort((a, b) => order[a.kind] - order[b.kind])
}

function deliveriesOf(board: BoardSnapshot): SieveHiveDelivery[] {
  const byId = new Map(board.notes.map(note => [note.id, note]))
  return board.deliveries.slice(-LATEST_DELIVERIES).flatMap((delivery) => {
    const note = byId.get(delivery.note)
    return note === undefined ? [] : [{ from: note.bee, to: delivery.to, kind: note.kind, score: delivery.score, text: clip(note.text, LINE_TEXT) }]
  })
}

function str(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function num(value: JsonValue | undefined): number | null {
  return typeof value === 'number' ? value : null
}

/** One gate entry as a readable row; entries of gates this version does not know are passed through by name. */
function verdictOf(entry: GateEntry, byId: ReadonlyMap<string, Note>): SieveHiveVerdict {
  const head = (id: JsonValue | undefined): string => {
    const note = byId.get(str(id))
    return note === undefined ? str(id) : `${note.bee}: ${clip(note.text, 100)}`
  }
  const pair = (ids: JsonValue | undefined): string => Array.isArray(ids) ? ids.map(id => `"${head(id)}"`).join(' vs ') : ''
  const base = { at: entry.at, gate: entry.gate, score: num(entry['score']) }
  switch (entry.gate) {
    case 'publish':
      return { ...base, bee: str(entry['bee']), passed: entry['publish'] === true, text: str(entry['head']) }
    case 'relate':
      return { ...base, bee: str(entry['by']), passed: entry['relation'] !== null, text: `${str(entry['relation']) || 'none'}: "${head(entry['later'])}" on "${head(entry['earlier'])}"` }
    case 'deliver':
      return { ...base, bee: str(entry['to']), passed: entry['deliver'] === true, text: `${str(entry['from'])} -> ${str(entry['to'])}: ${head(entry['note'])}` }
    case 'withheld':
      return { ...base, bee: str(entry['to']), passed: false, text: `${str(entry['why'])}: ${head(entry['note'])}` }
    case 'correct':
      return { ...base, bee: str(entry['to']), passed: null, text: `${str(entry['from'])} replaces "${head(entry['replaces'])}"` }
    case 'dispute':
      return { ...base, bee: str(entry['to']), passed: null, text: pair(entry['notes']) }
    case 'verify':
      return { ...base, bee: str(entry['bee']), passed: null, text: pair(entry['notes']) }
    default:
      return { ...base, bee: str(entry['bee']) || str(entry['to']), passed: null, text: '' }
  }
}

export function hiveRunView(record: HiveRunRecord): SieveHiveRun {
  const board = record.board
  const summary = summarizeBoard(board)
  const byId = new Map(board.notes.map(note => [note.id, note]))
  return {
    id: record.id,
    goal: record.goal,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    bees: record.bees.map(bee => ({
      name: bee.name,
      focus: bee.focus,
      placement: bee.placement,
      status: bee.status,
      verifier: bee.verifier,
      said: bee.said,
      startedAt: bee.startedAt,
      endedAt: bee.endedAt,
      published: summary.published[bee.name] ?? 0,
      received: summary.received[bee.name] ?? 0,
    })),
    links: hiveLinks(board),
    deliveries: deliveriesOf(board),
    verdicts: board.gates.slice(-LATEST_VERDICTS).map(entry => verdictOf(entry, byId)),
    counts: { notes: summary.notes, deliveries: summary.deliveries, judged: summary.judged, corrections: summary.corrections, conflicts: summary.conflicts },
    notes: record.notes,
  }
}

export function hiveView(enabled: boolean, records: readonly HiveRunRecord[]): SieveHiveView {
  return { v: HIVE_VIEW_VERSION, enabled, runs: records.map(hiveRunView) }
}
