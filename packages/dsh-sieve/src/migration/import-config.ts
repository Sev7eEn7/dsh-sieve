/** Explicit, credential-free translation of mu routes and modes (migration plan §8). */
import { DECISION_IDS } from '../runtime/config.ts'
import type { DecisionId, JudgeConfig, LlmRoute } from '../runtime/config.ts'
import { DECISION_MODES } from '../judge/decision.ts'
import type { DecisionMode } from '../judge/decision.ts'

type RecordValue = Record<string, unknown>
type ImportedJudge = JudgeConfig
interface ConvertedRoute { judge: ImportedJudge, credentialEnv?: string }
export interface ImportResult {
  config: { judge: ImportedJudge, modes: Record<string, DecisionMode>, routes: Record<string, LlmRoute> }
  credentialEnv?: string
  diagnostics: string[]
}

function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : {}
}
function tiers(value: unknown): string[] {
  return (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
    .filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
}

// Only explicit mu built-in routes are representable. Auto Jev/Gateway/Laya are reported.
const BUILTINS: Record<string, RecordValue> = {
  'jev-direct': { type: 'typesafe' },
  'jev-openrouter': { type: 'typesafe', baseUrl: 'https://openrouter.ai/api/v1/systemone', model: '~typesafe/jev-latest', apiKeyEnv: 'MU_JUDGE_OPENROUTER_API_KEY' },
  mock: { type: 'mock' },
}

function convert(name: string, input: RecordValue, report: (message: string) => void): ConvertedRoute | undefined {
  const value = { ...BUILTINS[name], ...input }
  const type = value['type']
  const judge: ImportedJudge = { type: 'off', timeoutMs: 4000, maxOutputTokens: 1024 }
  const timeout = value['timeoutMs']
  if (Number.isSafeInteger(timeout) && typeof timeout === 'number' && timeout > 0 && timeout <= 2_147_483_647) judge.timeoutMs = timeout
  else if (timeout !== undefined) report('跳过无效的 timeoutMs')
  if (type === 'mock') return { judge }
  if (type === 'llm' && typeof value['model'] === 'string') {
    const slash = value['model'].indexOf('/')
    if (slash <= 0 || slash === value['model'].length - 1) { report('llm 路由须写成 provider/model'); return undefined }
    judge.type = 'llm'; judge.provider = value['model'].slice(0, slash); judge.model = value['model'].slice(slash + 1)
    if (value['thinking'] !== undefined) report('thinking 无对应项，跳过')
    return { judge }
  }
  if (type !== 'typesafe') {
    report('路由没有对应项或依赖自动选择（Jev 自动路由、Laya、Gateway、CLM 可选认证、通用 HTTP），跳过')
    return undefined
  }
  judge.type = 'system-one'
  const env = value['apiKeyEnv'] ?? 'TYPESAFE_API_KEY'
  if (typeof env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) { report('apiKeyEnv 不是合法的环境变量名，跳过路由'); return undefined }
  const baseUrl = value['baseUrl']
  if (baseUrl !== undefined && baseUrl !== '') {
    if (typeof baseUrl !== 'string') { report('baseUrl 无效，跳过路由'); return undefined }
    let url: URL
    try { url = new URL(baseUrl) } catch { report('baseUrl 无效，跳过路由'); return undefined }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      report('baseUrl 含凭据、查询参数或非 HTTP 协议，跳过路由'); return undefined
    }
    judge.baseUrl = baseUrl
  }
  if (typeof value['model'] === 'string' && value['model'] !== '') judge.model = value['model']
  if (value['profile'] !== undefined) report('profile 能力覆写无对应项，跳过')
  report(`凭据未复制；运行前通过环境变量 ${env} 重新绑定`)
  return { judge, credentialEnv: env }
}

/** No files, environment variables, credentials or auth.json are read by this function. */
export function importMuConfig(raw: unknown): ImportResult {
  const input = record(raw)
  const diagnostics: string[] = []
  const result: ImportResult = { config: { judge: { type: 'off', timeoutMs: 4000, maxOutputTokens: 1024 }, modes: {}, routes: {} }, diagnostics }
  const judges = record(input['judges'])
  const route = (label: string, names: string[]): ConvertedRoute | undefined => {
    if (names.length !== 1) { diagnostics.push(`${label}：${names.length > 1 ? '级联无对应项' : '未指定显式 judge'}，跳过`); return undefined }
    const name = names[0]!
    return convert(name, record(judges[name]), message => diagnostics.push(`${label}：${message}`))
  }
  const primary = route('默认路由', tiers(input['tiers']))
  if (primary !== undefined) {
    result.config.judge = primary.judge
    if (primary.credentialEnv !== undefined) result.credentialEnv = primary.credentialEnv
  }
  for (const [id, mode] of Object.entries(record(input['modes']))) {
    if (id !== 'default' && !DECISION_IDS.includes(id as DecisionId)) { diagnostics.push(`模式 ${id}：不在首版范围，跳过`); continue }
    if (!DECISION_MODES.includes(mode as DecisionMode)) { diagnostics.push(`模式 ${id}：值无效，跳过`); continue }
    result.config.modes[id] = mode as DecisionMode
  }
  for (const [id, names] of Object.entries(record(input['routes']))) {
    if (!DECISION_IDS.includes(id as DecisionId)) { diagnostics.push(`路由 ${id}：不在首版范围，跳过`); continue }
    const translated = route(`路由 ${id}`, tiers(names))
    if (translated === undefined) continue
    const { judge } = translated
    if (JSON.stringify(translated) === JSON.stringify(primary)) continue
    if (result.config.judge.type === 'llm' && judge.type === 'llm' && judge.provider !== undefined && judge.model !== undefined) {
      result.config.routes[id as DecisionId] = { provider: judge.provider, model: judge.model }
      if (judge.timeoutMs !== undefined) diagnostics.push(`路由 ${id}：独立 timeoutMs 无对应项，使用全局时限`)
    } else diagnostics.push(`路由 ${id}：混合后端无对应项，跳过`)
  }
  for (const field of ['features', 'writer', 'mcp', 'recordState']) if (input[field] !== undefined) diagnostics.push(`${field}：§8 只导入路由与模式，跳过`)
  return result
}

/** A complete row override for --patch; credentials remain lazy environment references. */
export function renderImportPatch(result: ImportResult): string {
  const lines = ['- id: sieve', '  config:', '    judge:']
  for (const [key, value] of Object.entries(result.config.judge)) lines.push(`      ${key}: ${JSON.stringify(value)}`)
  if (result.credentialEnv !== undefined) lines.push(`      apiKey: !!js ${JSON.stringify(`process.env[${JSON.stringify(result.credentialEnv)}]`)}`)
  lines.push(`    modes: ${JSON.stringify(result.config.modes)}`, `    routes: ${JSON.stringify(result.config.routes)}`)
  return `${lines.join('\n')}\n`
}
