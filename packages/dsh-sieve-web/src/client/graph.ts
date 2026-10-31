/**
 * Where the Hive map puts things, in pixels of the stage it is drawn on. The
 * bees stand on a ring: one or two of them face each other across it, three
 * or more are spread at equal distances along it, from the top, clockwise.
 * The ring is as wide as the stage allows and as tall as the bees need: it
 * grows downwards until no two of their boxes (avatar, name, status, counts)
 * touch.
 *
 * Ported from mu
 * `desktop/packages/desktop/src/renderer/pages/conversation/KyrnPanel/Hive/Graph/layout.ts`
 * (mu's centre node for delegate runs is dropped: sieve has no delegate runs).
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * @module
 */

export interface Point {
  readonly x: number
  readonly y: number
}

export const NODE_WIDTH = 84
/** The avatar and up to two lines of name, the status and the counts under it. */
export const NODE_HEIGHT = 118
export const AVATAR_RADIUS = 22
/** Above and below the ring: room for a line that bends outwards between two neighbours. */
const MARGIN = 28
const NODE_GAP = 8
const MIN_STAGE = 200
const SAMPLES = 720

export interface RingLayout {
  readonly width: number
  readonly height: number
  readonly centre: Point
  readonly nodes: ReadonlyMap<string, Point>
}

/** The ellipse from the top, clockwise, as evenly spaced samples with their distance along it. */
function trace(rx: number, ry: number): { points: Point[], along: number[] } {
  const points: Point[] = []
  const along: number[] = [0]
  for (let i = 0; i <= SAMPLES; i += 1) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / SAMPLES
    points.push({ x: rx * Math.cos(angle), y: ry * Math.sin(angle) })
    if (i > 0) along.push(along[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y))
  }
  return { points, along }
}

/** `n` points at equal distances along the ellipse, the first at the top or, for an even count, half a step past it. */
function spread(rx: number, ry: number, n: number): Point[] {
  const { points, along } = trace(rx, ry)
  const length = along[SAMPLES]!
  const start = n % 2 === 0 ? length / (2 * n) : 0
  const result: Point[] = []
  let at = 0
  for (let i = 0; i < n; i += 1) {
    const wanted = start + (length * i) / n
    while (at < SAMPLES && along[at + 1]! < wanted) at += 1
    const step = along[at + 1]! - along[at]! || 1
    const t = Math.min(1, Math.max(0, (wanted - along[at]!) / step))
    result.push({
      x: points[at]!.x + (points[at + 1]!.x - points[at]!.x) * t,
      y: points[at]!.y + (points[at + 1]!.y - points[at]!.y) * t,
    })
  }
  return result
}

/** Whether any two nodes' boxes touch: the boxes hang from the avatars, so two neighbours may sit side by side or one under the other. */
function crowded(points: readonly Point[]): boolean {
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const dx = Math.abs(points[i]!.x - points[j]!.x)
      const dy = Math.abs(points[i]!.y - points[j]!.y)
      if (dx < NODE_WIDTH + NODE_GAP && dy < NODE_HEIGHT + NODE_GAP) return true
    }
  }
  return false
}

export function ringLayout(names: readonly string[], stageWidth: number): RingLayout {
  const width = Math.max(MIN_STAGE, Math.floor(stageWidth) || MIN_STAGE)
  const n = names.length
  const rx = Math.max(40, (width - NODE_WIDTH) / 2 - NODE_GAP)
  let ry = n <= 2 ? 0 : rx * 0.55
  let placed = n <= 2 ? names.map((_, index) => ({ x: -rx + 2 * rx * index, y: 0 })) : spread(rx, ry, n)
  // A ring too small for its bees grows downwards until none of them touch.
  if (n > 2) {
    while (crowded(placed) && ry < rx * 8) {
      ry += 16
      placed = spread(rx, ry, n)
    }
  }
  const centre = { x: width / 2, y: MARGIN + AVATAR_RADIUS + ry }
  const height = Math.ceil(centre.y + ry + (NODE_HEIGHT - AVATAR_RADIUS) + MARGIN)
  const nodes = new Map<string, Point>()
  names.forEach((name, index) => nodes.set(name, { x: centre.x + placed[index]!.x, y: centre.y + placed[index]!.y }))
  return { width, height, centre, nodes }
}

/**
 * Where a line leaves a node, on the ray from the avatar's centre towards the
 * other end: at the avatar's edge, or, when the ray would run down through
 * the words under the avatar, at the edge of the node's box instead, so that
 * a line never crosses its own node's words.
 */
function edge(from: Point, toward: Point, gap: number): Point {
  const dx = toward.x - from.x
  const dy = toward.y - from.y
  const length = Math.hypot(dx, dy) || 1
  const radius = AVATAR_RADIUS + gap
  const throughWords = dy > 0 && (AVATAR_RADIUS * Math.abs(dx)) / dy <= NODE_WIDTH / 2 + 4
  if (!throughWords) return { x: from.x + (dx / length) * radius, y: from.y + (dy / length) * radius }
  const half = NODE_WIDTH / 2 + gap
  const bottom = NODE_HEIGHT - AVATAR_RADIUS + gap
  const t = Math.min(dx > 0 ? half / dx : dx < 0 ? -half / dx : Infinity, bottom / dy)
  return { x: from.x + dx * t, y: from.y + dy * t }
}

const at = (point: Point): string => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`

/**
 * A line from one node to another as two quadratic curves that meet halfway
 * (so a marker can sit in the middle), from the edge of one node to the edge
 * of the other and bent sideways so that a pair of lines going both ways, or
 * a line across the ring, never runs through a node. `bend` picks the side.
 */
export function linkPath(from: Point, to: Point, bend: 1 | -1, endGap = 7): string {
  const start = edge(from, to, 3)
  const end = edge(to, from, endGap)
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy) || 1
  const unit = { x: dx / length, y: dy / length }
  // A short line between neighbours bends only a little, or it would curl.
  const offset = bend * (0.22 * length + 12 * Math.min(1, length / 100))
  const control = {
    x: (start.x + end.x) / 2 - unit.y * offset,
    y: (start.y + end.y) / 2 + unit.x * offset,
  }
  const middle = {
    x: 0.25 * start.x + 0.5 * control.x + 0.25 * end.x,
    y: 0.25 * start.y + 0.5 * control.y + 0.25 * end.y,
  }
  const c1 = { x: (start.x + control.x) / 2, y: (start.y + control.y) / 2 }
  const c2 = { x: (control.x + end.x) / 2, y: (control.y + end.y) / 2 }
  return `M${at(start)} Q${at(c1)} ${at(middle)} Q${at(c2)} ${at(end)}`
}

/** The side a line bends to: the same pair always bends the same way, and the way back bends the other way. */
export const bendOf = (from: string, to: string): 1 | -1 => (from < to ? 1 : -1)
