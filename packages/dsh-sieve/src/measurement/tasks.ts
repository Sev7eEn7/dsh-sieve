/** Fixed, network-free development fixtures; validators remain outside model workspaces. */
export interface MeasurementTask {
  id: string
  prompts: readonly string[]
  files: Readonly<Record<string, string>>
  /** Files the model may change; every other fixture file must stay byte-identical. */
  editable: readonly string[]
  /** A repair the oracle must accept. */
  reference: Readonly<Record<string, string>>
  /** A plausible but incomplete repair the oracle must reject. */
  wrong: Readonly<Record<string, string>>
}

/** Environment variable naming an append-only file, outside the workspace, where each build records its id. */
export const BUILD_LOG_ENV = 'SIEVE_FIXTURE_BUILD_LOG'

const source = 'export function transform(value) { return value - 1 }\n'
const noisyIntegerTests = `for (let i = 0; i < 80; i++) {
test('integer ' + i, () => {
  console.log('fixture notice: ' + 'same successful-test stdout '.repeat(6))
  assert.equal(calc.transform(i), i + 1)
})
if (i === 39) test('numeric string conversion', () => assert.equal(calc.transform('41'), 42))
}
`
const test = `import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import * as calc from './src/calc.mjs'
${noisyIntegerTests}`
const build = `import { transform } from './src/calc.mjs'
for (let i = 0; i < 200; i++) {
  console.log('npm warn fixture: ' + 'repeated optional build notice '.repeat(5))
  console.log('Progress: ' + (i % 100) + '%')
  if (i === 100 && transform('dozen') !== 13) {
    console.log("BUILD ERROR: transform('dozen') must be 13; the word dozen means 12")
    process.exitCode = 1
  }
}
if (transform(7) !== 8) { console.error('BUILD ERROR: transform(7) must be 8'); process.exitCode = 1 }
else console.log('Build complete: checksum 8')
`
const packageJson = `${JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test test.mjs', build: 'node build.mjs' } }, null, 2)}\n`
const rules = (editable: string): string => `# 测量夹具规则\n本目录是独立测试项目，只修改 ${editable}。不要修改测试、构建、技能或配置；不要安装依赖、调用网络或读取外层项目。不要委派子任务。\n`
const base = { 'src/calc.mjs': source, 'test.mjs': test, 'build.mjs': build, 'AGENTS.md': rules('src/calc.mjs'), 'package.json': packageJson }
const skills = Object.fromEntries([
  ['code', 'JavaScript code, integer arithmetic and regression tests'], ['slides', 'Presentation slides and decks'],
  ['insurance', 'Insurance policy analysis'], ['travel', 'Travel planning'], ['sql', 'SQL databases'],
  ['images', 'Raster image generation'], ['legal', 'Contract review'], ['music', 'Music composition'],
].map(([name, description]) => [`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nOnly use this capability when it helps the task.\n${name === 'code' ? 'The transform function must throw TypeError for null.\n' : ''}`]))

export const REFERENCE_FIX = "export function transform(value) { if (value === null) throw new TypeError('null'); return (value === 'dozen' ? 12 : Number(value)) + 1 }\n"

const longTest = `import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import * as calc from './src/calc.mjs'
import * as format from './src/format.mjs'
import * as stats from './src/stats.mjs'
${noisyIntegerTests}test('formatList empty', () => assert.equal(format.formatList([]), ''))
test('formatList one', () => assert.equal(format.formatList(['a']), 'a'))
test('formatList two', () => assert.equal(format.formatList(['a', 'b']), 'a and b'))
test('formatList three', () => assert.equal(format.formatList(['a', 'b', 'c']), 'a, b and c'))
test('mean empty', () => assert.equal(stats.mean([]), 0))
test('mean values', () => assert.equal(stats.mean([1, 2, 3, 4]), 2.5))
test('median empty', () => assert.equal(stats.median([]), 0))
test('median odd', () => assert.equal(stats.median([3, 1, 2]), 2))
test('median even', () => assert.equal(stats.median([4, 1, 3, 2]), 2.5))
`
// The id is printed first and differs on every build; only the first build's output can answer the last prompt.
const longBuild = `import { appendFileSync } from 'node:fs'
import { randomInt } from 'node:crypto'
import * as calc from './src/calc.mjs'
import * as format from './src/format.mjs'
import * as stats from './src/stats.mjs'
const id = 'BLD-' + randomInt(100000, 1000000)
console.log('Build ID: ' + id)
if (process.env.${BUILD_LOG_ENV}) appendFileSync(process.env.${BUILD_LOG_ENV}, id + '\\n')
const checks = [
  ['transform(7) must be 8', () => calc.transform(7) === 8],
  ["formatList(['a', 'b', 'c']) must be 'a, b and c'", () => format.formatList(['a', 'b', 'c']) === 'a, b and c'],
  ['mean([]) must be 0', () => stats.mean([]) === 0],
  ['median([4, 1, 3, 2]) must be 2.5', () => typeof stats.median === 'function' && stats.median([4, 1, 3, 2]) === 2.5],
]
for (let i = 0; i < 200; i++) {
  console.log('npm warn fixture: ' + 'repeated optional build notice '.repeat(5))
  console.log('Progress: ' + (i % 100) + '%')
  if (i === 100) for (const [name, check] of checks) {
    let ok = false
    try { ok = check() } catch {}
    if (!ok) { console.log('BUILD ERROR: ' + name); process.exitCode = 1 }
  }
}
console.log(process.exitCode ? 'Build failed' : 'Build complete')
`
const longFiles = {
  'src/calc.mjs': source,
  'src/format.mjs': "export function formatList(values) { return values.join(', ') }\n",
  'src/stats.mjs': 'export function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length }\n',
  'test.mjs': longTest, 'build.mjs': longBuild, 'AGENTS.md': rules('src/ 目录下的文件'), 'package.json': packageJson,
}
const longReference = {
  'src/calc.mjs': 'export function transform(value) { return Number(value) + 1 }\n',
  'src/format.mjs': "export function formatList(values) { return values.length < 2 ? values.join('') : values.slice(0, -1).join(', ') + ' and ' + values.at(-1) }\n",
  'src/stats.mjs': `export function mean(values) { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length }
export function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
`,
}

export const TASKS: readonly MeasurementTask[] = [
  { id: 'test-log', files: base, editable: ['src/calc.mjs'],
    prompts: ['运行 npm test，根据失败修复 src/calc.mjs，直到全部通过。'],
    reference: { 'src/calc.mjs': REFERENCE_FIX }, wrong: { 'src/calc.mjs': 'export function transform(value) { return value + 1 }\n' } },
  { id: 'build-output', files: base, editable: ['src/calc.mjs'],
    prompts: ['运行 npm run build，根据失败修复 src/calc.mjs，直到构建与测试全部通过。'],
    reference: { 'src/calc.mjs': REFERENCE_FIX }, wrong: { 'src/calc.mjs': 'export function transform(value) { return Number(value) + 1 }\n' } },
  { id: 'skills', files: { ...base, ...skills }, editable: ['src/calc.mjs'],
    prompts: ['先加载与本任务相关的技能并遵循其中规则，再根据 npm test 的失败修复 src/calc.mjs 并运行测试。'],
    reference: { 'src/calc.mjs': REFERENCE_FIX }, wrong: { 'src/calc.mjs': 'export function transform(value) { return Number(value) + 1 }\n' } },
  { id: 'long-session', files: longFiles, editable: ['src/calc.mjs', 'src/format.mjs', 'src/stats.mjs'],
    prompts: [
      '运行 npm run build 查看构建输出，然后阅读 src 目录下的全部源文件和 test.mjs，概述项目结构和当前的失败点。这一轮不修改文件。',
      '运行 npm test，修复 src/calc.mjs 中 transform 相关的失败，再运行 npm test 确认这部分通过。其他模块的失败留到后面处理。',
      '修复 src/format.mjs 的 formatList，使相关测试通过，并运行 npm test。',
      '修复 src/stats.mjs 的 mean，使相关测试通过，并运行 npm test。',
      '在 src/stats.mjs 中实现并导出 median(values)：空数组返回 0，元素个数为偶数时返回中间两个数的平均值。实现后运行 npm test。',
      '运行 npm test 和 npm run build，确认全部通过；如有失败就修复后再验证。',
      '第一次构建输出里的构建编号是多少？只回答编号本身。',
    ],
    reference: longReference, wrong: { ...longReference, 'src/stats.mjs': 'export function mean(values) { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length }\nexport function median(values) { return values.length === 0 ? 0 : [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] }\n' } },
]

export function assertFixtureIntact(task: MeasurementTask, actual: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(task.files)) if (!task.editable.includes(path) && actual[path] !== text) throw new Error(`Fixture modified: ${path}`)
}

export type RecallClass = 'correct' | 'wrong' | 'unknown'
const UNCERTAIN = /无法确定|不确定|不知道|不记得|记不清|无法找到|找不到|看不到|没有.{0,12}(记录|保留|信息)|无法(回答|得知|获取|确认)|cannot|can't|don't know|do not know|not sure|unable/i
/**
 * Preregistered recall classes: build ids are `BLD-` tokens (bare six-digit
 * numbers count only when the answer has no `BLD-` token, so code such as
 * `randomInt(100000, 1000000)` is not a candidate). Exactly one distinct id
 * equal to the first build's is correct; a wrong id or several distinct ids
 * are wrong; no id together with an explicit statement of not knowing is
 * unknown; anything else is wrong.
 */
export function classifyRecall(answer: string, expected: string): RecallClass {
  const digits = expected.replace(/^BLD-/, '')
  const prefixed = [...answer.matchAll(/BLD-(\d{6})(?!\d)/g)].map(match => match[1])
  const bare = [...answer.matchAll(/(?<![\d-])(\d{6})(?!\d)/g)].map(match => match[1])
  const candidates = new Set(prefixed.length > 0 ? prefixed : bare)
  if (candidates.size === 1 && candidates.has(digits)) return 'correct'
  if (candidates.size > 0) return 'wrong'
  return UNCERTAIN.test(answer) ? 'unknown' : 'wrong'
}
