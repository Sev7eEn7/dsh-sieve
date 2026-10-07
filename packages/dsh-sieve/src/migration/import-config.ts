/** Explicit, credential-free translation of mu routes and modes (migration plan §8). */
import { DECISION_IDS } from '../runtime/config.ts'
import type { DecisionId, JudgeConfig } from '../runtime/config.ts'
import { DECISION_MODES } from '../judge/decision.ts'
import type { DecisionMode } from '../judge/decision.ts'

type RecordValue = Record<string, unknown>
type ImportedJudge = JudgeConfig
interface ConvertedRoute { judge: ImportedJudge, credentialEnv?: string }
export interface ImportResult {
  config: { judge: ImportedJudge, modes: Record<string, DecisionMode> }
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

// Only explicit Jev and Laya routes are representable; sieve has no session-model judge. Auto Jev, Gateway and the rest are reported.
const BUILTINS: Record<string, RecordValue> = {
  'jev-direct': { type: 'typesafe' },
  'jev-openrouter': { type: 'typesafe', baseUrl: 'https://openrouter.ai/api/v1/systemone', model: '~typesafe/jev-latest', apiKeyEnv: 'MU_JUDGE_OPENROUTER_API_KEY' },
  laya: { type: 'local' },
}

/** Without an explicit Jev or Laya route the import keeps sieve's default: Jev with a stored key. */
const DEFAULT_JUDGE = (): ImportedJudge => ({ type: 'auto', timeoutMs: 4000 })

function httpUrl(value: unknown, report: (message: string) => void): string | null | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') { report('baseUrl 无效，跳过路由'); return null }
  let url: URL
  try { url = new URL(value) } catch { report('baseUrl 无效，跳过路由'); return null }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    report('baseUrl 含凭据、查询参数或非 HTTP 协议，跳过路由'); return null
  }
  return value
}

function convert(name: string, input: RecordValue, report: (message: string) => void): ConvertedRoute | undefined {
  const value = { ...BUILTINS[name], ...input }
  const type = value['type']
  const judge: ImportedJudge = DEFAULT_JUDGE()
  const timeout = value['timeoutMs']
  if (Number.isSafeInteger(timeout) && typeof timeout === 'number' && timeout > 0 && timeout <= 2_147_483_647) judge.timeoutMs = timeout
  else if (timeout !== undefined) report('跳过无效的 timeoutMs')
  if (type === 'local') {
    judge.type = 'laya'
    // mu's local judge is the same sidecar: only its address carries over.
    const baseUrl = httpUrl(value['baseUrl'], report)
    if (baseUrl === null) return undefined
    if (baseUrl !== undefined) judge.baseUrl = baseUrl
    if (value['profile'] !== undefined) report('profile 能力覆写无对应项，跳过')
    return { judge }
  }
  if (type === 'llm' || type === 'mock') {
    report('sieve 只用 Jev 或 Laya 判断，不用会话模型或其他 LLM，跳过')
    return undefined
  }
  if (type !== 'typesafe') {
    report('路由没有对应项或依赖自动选择（Jev 自动路由、Gateway、CLM 可选认证、通用 HTTP），跳过')
    return undefined
  }
  judge.type = 'system-one'
  const env = value['apiKeyEnv'] ?? 'TYPESAFE_API_KEY'
  if (typeof env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) { report('apiKeyEnv 不是合法的环境变量名，跳过路由'); return undefined }
  const baseUrl = httpUrl(value['baseUrl'], report)
  if (baseUrl === null) return undefined
  if (baseUrl !== undefined) judge.baseUrl = baseUrl
  if (typeof value['model'] === 'string' && value['model'] !== '') judge.model = value['model']
  if (value['profile'] !== undefined) report('profile 能力覆写无对应项，跳过')
  report(`凭据未复制；运行前通过环境变量 ${env} 重新绑定`)
  return { judge, credentialEnv: env }
}

/** No files, environment variables, credentials or auth.json are read by this function. */
export function importMuConfig(raw: unknown): ImportResult {
  const input = record(raw)
  const diagnostics: string[] = []
  const result: ImportResult = { config: { judge: DEFAULT_JUDGE(), modes: {} }, diagnostics }
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
    if (translated === undefined || JSON.stringify(translated) === JSON.stringify(primary)) continue
    diagnostics.push(`路由 ${id}：sieve 所有决策共用一个 judge，按决策指定的路由无对应项，跳过`)
  }
  for (const field of ['features', 'writer', 'mcp', 'recordState']) if (input[field] !== undefined) diagnostics.push(`${field}：§8 只导入路由与模式，跳过`)
  return result
}

/** A complete row override for --patch; credentials remain lazy environment references. */
export function renderImportPatch(result: ImportResult): string {
  const lines = ['- id: sieve', '  config:', '    judge:']
  for (const [key, value] of Object.entries(result.config.judge)) lines.push(`      ${key}: ${JSON.stringify(value)}`)
  if (result.credentialEnv !== undefined) lines.push(`      apiKey: !!js ${JSON.stringify(`process.env[${JSON.stringify(result.credentialEnv)}]`)}`)
  lines.push(`    modes: ${JSON.stringify(result.config.modes)}`)
  return `${lines.join('\n')}\n`
}
