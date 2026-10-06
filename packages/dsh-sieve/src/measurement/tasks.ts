/** Fixed, network-free development fixtures; validators remain outside model workspaces. */
export interface MeasurementTask { id: string, prompts: readonly string[], files: Readonly<Record<string, string>> }
const source = 'export function transform(value) { return value - 1 }\n'
const test = `import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { transform } from './src/calc.mjs'
for (let i = 0; i < 80; i++) test('integer ' + i, () => {
  console.log('fixture notice: ' + 'same successful-test stdout '.repeat(6))
  assert.equal(transform(i), i + 1)
})
`
const build = `import { transform } from './src/calc.mjs'
for (let i = 0; i < 200; i++) {
  console.log('npm warn fixture: ' + 'repeated optional build notice '.repeat(5))
  console.log('Progress: ' + (i % 100) + '%')
}
if (transform(7) !== 8) { console.error('BUILD ERROR: transform(7) must be 8'); process.exitCode = 1 }
else console.log('Build complete: checksum 8')
`
const base = { 'src/calc.mjs': source, 'test.mjs': test, 'build.mjs': build,
  'AGENTS.md': '# 测量夹具规则\n本目录是独立测试项目，只修改 src/calc.mjs。不要修改测试、构建、技能或配置；不要安装依赖、调用网络或读取外层项目。不要委派子任务。\n',
  'package.json': `${JSON.stringify({ private: true, type: 'module', scripts: { test: 'node --test test.mjs', build: 'node build.mjs' } }, null, 2)}\n` }
const skills = Object.fromEntries([
  ['code', 'JavaScript code, integer arithmetic and regression tests'], ['slides', 'Presentation slides and decks'],
  ['insurance', 'Insurance policy analysis'], ['travel', 'Travel planning'], ['sql', 'SQL databases'],
  ['images', 'Raster image generation'], ['legal', 'Contract review'], ['music', 'Music composition'],
].map(([name, description]) => [`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nOnly use this capability when it helps the task.\n`]))

export const TASKS: readonly MeasurementTask[] = [
  { id: 'long-test-log', files: base, prompts: ['修复 src/calc.mjs 的整数加一函数。先运行 npm test 查看失败，再修复并重新测试。保留测试与构建脚本。'] },
  { id: 'long-build-output', files: base, prompts: ['运行 npm run build，根据报错修复 transform 的整数加一行为，再运行构建和测试确认。保留测试与构建脚本。'] },
  { id: 'repeated-full-read', files: { ...base, 'config.txt': Array.from({ length: 200 }, (_, i) => `setting_${i}=${'reference value '.repeat(8)}`).join('\n') },
    prompts: ['先用 read 读取 config.txt，然后检查 src/calc.mjs。此步只诊断，不修改。',
      '修复整数加一函数并运行测试。修改前后各用 read 读取 config.txt；保留测试与构建脚本。',
      '再次用 read 检查 config.txt，确认没有修改配置，然后运行测试，报告结果。'] },
  { id: 'many-skills', files: { ...base, ...skills }, prompts: ['修复 src/calc.mjs 的整数加一行为并运行 npm test，不修改测试与构建脚本。需要合适的技能时可加载。'] },
]

export function assertFixtureIntact(task: MeasurementTask, actual: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(task.files)) if (path !== 'src/calc.mjs' && actual[path] !== text) throw new Error(`Fixture modified: ${path}`)
}
