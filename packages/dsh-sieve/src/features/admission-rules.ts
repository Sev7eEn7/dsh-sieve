/**
 * Admission gates.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 *
 * Two rules that need no judge, written for sieve: runs of lines that differ
 * at most in numbers fold to their ends, and runs that repeat text the model
 * already has in context become a reference to it.
 */
import { ANSI, anchorTerms, MARKER_PREFIX } from '../judge/admission/test-log.ts'

/** A request to see an output as it is; admission and forgetting leave everything alone for it. */
export const FULL_OUTPUT_REQUEST = /\b(?:verbatim|full (?:log|output)|entire (?:log|output))\b|完整(?:日志|输出)|原样/i

/** Exact line-boundary splitting, including the original line endings. */
export function chunkLines(text: string, size: number): string[] {
  const chunks: string[] = []
  let current = ''
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (current !== '' && current.length + line.length > size) {
      chunks.push(current)
      current = ''
    }
    current += line
    while (current.length > size) {
      let end = size
      const code = current.charCodeAt(end - 1)
      if (code >= 0xd800 && code <= 0xdbff) end--
      if (end === 0) end = Math.min(2, current.length)
      chunks.push(current.slice(0, end))
      current = current.slice(end)
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/**
 * Middle chunks the judge may be asked about: never the first or the last, and
 * never one that names something from the goal or the intent.
 */
export function judgeCandidates(chunks: readonly string[], goal: string, intent: string): number[] {
  const anchors = anchorTerms(goal, intent)
  const candidates: number[] = []
  chunks.forEach((chunk, index) => {
    const anchored = anchors.some(anchor => chunk.toLowerCase().includes(anchor))
    const marker = chunk.split('\n').some(line => line.startsWith(MARKER_PREFIX))
    if (index > 0 && index < chunks.length - 1 && !anchored && !marker && chunk.trim() !== '') candidates.push(index)
  })
  return candidates
}

export function describeCall(name: string, args: unknown): string {
  const input = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
  const value = input['command'] ?? input['pattern'] ?? input['file_path'] ?? input['path'] ?? input['query']
  return `${name}: ${typeof value === 'string' ? value : JSON.stringify(args)}`.slice(0, 300)
}

/**
 * Whether a rewrite only removes: every line that is not a sieve marker, or
 * the retrieval hint after the archive pointer, occurs in the original, in
 * order. A chunk boundary may cut a very long line, so a kept line may be a
 * piece of an original one.
 */
export function keptInOrder(rewritten: string, original: string): boolean {
  let from = 0
  let afterPointer = false
  for (const raw of rewritten.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const pointer = line.startsWith(MARKER_PREFIX) && line.includes('full output: ')
    if (line === '' || line.startsWith(MARKER_PREFIX) || afterPointer) {
      afterPointer = pointer
      continue
    }
    const at = original.indexOf(line, from)
    if (at < 0) return false
    from = at + line.length
  }
  return true
}

/** Lines with their endings, so joining them gives the text back. */
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function bare(line: string): string {
  return line.replace(/\r?\n$/, '')
}

function isMarker(line: string): boolean {
  return line.startsWith(MARKER_PREFIX)
}

/** A run must be longer than its marker by at least this much to be folded or referenced. */
const MIN_RUN_SAVING = 40

/** Folds runs this long, keeping this many lines at each end. */
const MIN_SIMILAR_RUN = 6
const SIMILAR_EDGE_LINES = 2

/**
 * A line with every number, address and hash replaced, so lines that differ
 * only there compare equal while a changed word still tells them apart.
 */
export function lineShape(line: string): string {
  return line.replace(ANSI, '').replace(/\r?\n$/, '')
    .replace(/0x[0-9a-f]+/gi, '0x#')
    .replace(/\b[0-9a-f]{7,}\b/gi, hash => /\d/.test(hash) ? '#' : hash)
    .replace(/\d+/g, '#')
    .trimEnd()
}

export interface RuleResult {
  readonly text: string
  /** Lines replaced by markers. */
  readonly lines: number
}

/**
 * Runs of at least six consecutive lines with the same shape (equal up to
 * numbers): progress, downloads, polling loops, timestamps. The first and the
 * last two lines stay, so the range and where it ended remain visible; a word
 * that changes (False → True) starts a new run. Lines that mention something
 * from the goal or the intent always stay.
 */
export function foldSimilarLines(text: string, goal = '', intent = ''): RuleResult {
  const lines = linesOf(text)
  const anchors = anchorTerms(goal, intent)
  const shapes = lines.map(lineShape)
  const keeps = (index: number): boolean => {
    const line = lines[index] ?? ''
    return isMarker(line) || (shapes[index] ?? '').trim() === '' || anchors.some(anchor => line.toLowerCase().includes(anchor))
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  let out = ''
  let folded = 0
  let start = 0
  while (start < lines.length) {
    let end = start + 1
    if (!keeps(start)) while (end < lines.length && shapes[end] === shapes[start] && !keeps(end)) end++
    const middle = lines.slice(start + SIMILAR_EDGE_LINES, end - SIMILAR_EDGE_LINES)
    const marker = `${MARKER_PREFIX}omitted ${middle.length} similar lines, equal up to numbers]${eol}`
    if (end - start >= MIN_SIMILAR_RUN && middle.join('').length >= marker.length + MIN_RUN_SAVING) {
      out += lines.slice(start, start + SIMILAR_EDGE_LINES).join('') + marker + lines.slice(end - SIMILAR_EDGE_LINES, end).join('')
      folded += middle.length
    } else out += lines.slice(start, end).join('')
    start = end
  }
  return { text: out, lines: folded }
}

/** A tool result the model can still see, as a source of repeated text. */
export interface VisibleOutput {
  /** Its tool call, named in the reference so the model and forgetting can find it. */
  readonly callId: string
  /** How the model knows it, e.g. `bash: pytest tests/test_a.py`. */
  readonly label: string
  readonly text: string
}

/** The calls whose output a reference in `text` points to; forgetting keeps them while it is visible. */
export function referencedCalls(text: string): string[] {
  return [...text.matchAll(/^\[sieve: omitted \d+ lines identical to the output of call (\S+) \(/gm)].map(match => match[1] ?? '')
}

/** A repeated run must be at least this long, as in the test-log duplicate rule. */
const MIN_REPEAT_LINES = 6
const MIN_REPEAT_CHARS = 200
const LABEL_CHARS = 80
const QUOTE_CHARS = 60

interface Origin {
  /** Index into the sources; -1 for the output being admitted. */
  readonly source: number
  readonly line: number
}

/** FNV-1a over a window; matches are confirmed line by line, so a collision only costs a lookup. */
function hash(text: string): number {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 0x01000193)
  return value >>> 0
}

function windowKey(lines: readonly string[], at: number): number | undefined {
  const window = lines.slice(at, at + MIN_REPEAT_LINES)
  if (window.length < MIN_REPEAT_LINES || window.some(isMarker)) return undefined
  const joined = window.join('\n')
  return joined.replace(/\s/g, '').length < 60 ? undefined : hash(joined)
}

/** One line of marker text: no ANSI, no line break, no closing bracket, at most `limit` characters. */
function quote(line: string, limit: number): string {
  const plain = line.replace(ANSI, '').trim().replace(/[\]\r\n]/g, ' ')
  return plain.length <= limit ? plain : `${plain.slice(0, limit - 1)}…`
}

/**
 * Replaces runs of at least six lines and 200 characters that repeat, line
 * for line, an earlier output the model still sees, or an earlier kept part of
 * this output: a test rerun printing the same traceback, the same file region
 * read again. Nothing is lost while the source stays in context; the caller
 * archives the original for when it does not.
 * @param options - `self: false` references other outputs only, for file content.
 */
export function dedupAgainst(text: string, sources: readonly VisibleOutput[], options: { readonly self?: boolean } = {}): RuleResult {
  const self = options.self ?? true
  const lines = linesOf(text)
  const bareLines = lines.map(bare)
  const sourceLines = sources.map(source => linesOf(source.text).map(bare))
  const index = new Map<number, Origin[]>()
  const add = (key: number | undefined, origin: Origin): void => {
    if (key === undefined) return
    const list = index.get(key)
    if (list === undefined) index.set(key, [origin])
    else if (list.length < 4) list.push(origin)
  }
  sourceLines.forEach((source, at) => {
    for (let line = 0; line + MIN_REPEAT_LINES <= source.length; line++) add(windowKey(source, line), { source: at, line })
  })
  // Kept lines of this output; a reference into them never crosses a place where lines were replaced.
  const kept: string[] = []
  const gapBefore = new Set<number>()
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  let out = ''
  let replaced = 0
  let streak = 0
  let at = 0
  while (at < lines.length) {
    let best: { origin: Origin, length: number } | undefined
    for (const origin of index.get(windowKey(bareLines, at) ?? -1) ?? []) {
      const own = origin.source === -1
      const source = own ? kept : sourceLines[origin.source] ?? []
      let length = 0
      while (at + length < lines.length && origin.line + length < source.length
        && !isMarker(lines[at + length] ?? '') && bareLines[at + length] === source[origin.line + length]
        && !(own && length > 0 && gapBefore.has(origin.line + length))) length++
      if (length > (best?.length ?? 0)) best = { origin, length }
    }
    const run = best === undefined ? [] : lines.slice(at, at + best.length)
    const source = best === undefined || best.origin.source === -1 ? undefined : sources[best.origin.source]
    const label = source === undefined ? 'above in this output' : `of call ${source.callId.replace(/\s/g, '')} (\`${quote(source.label, LABEL_CHARS)}\`) above`
    const marker = `${MARKER_PREFIX}omitted ${run.length} lines identical to the output ${label}, from "${quote(run[0] ?? '', QUOTE_CHARS)}"]${eol}`
    if (best !== undefined && best.length >= MIN_REPEAT_LINES && run.join('').length >= Math.max(MIN_REPEAT_CHARS, marker.length + MIN_RUN_SAVING)) {
      out += marker
      replaced += run.length
      at += best.length
      streak = 0
      gapBefore.add(kept.length)
      continue
    }
    const line = lines[at] ?? ''
    out += line
    if (isMarker(line)) gapBefore.add(kept.length + 1)
    kept.push(bareLines[at] ?? '')
    // A window of this output becomes a source once every line of it is known to stay.
    if (isMarker(line)) streak = 0
    else if (++streak >= MIN_REPEAT_LINES && self) add(windowKey(kept, kept.length - MIN_REPEAT_LINES), { source: -1, line: kept.length - MIN_REPEAT_LINES })
    at++
  }
  return { text: out, lines: replaced }
}
