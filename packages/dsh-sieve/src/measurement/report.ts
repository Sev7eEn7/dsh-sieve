/** Cost comparison uses disjoint input buckets and never treats missing usage as free. */
import type { JudgeUsage } from '../judge/types.ts'
import type { LedgerRecord } from '../judge/ledger.ts'

export interface Prices {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: 'included' | number
}
export interface UsageSummary {
  inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number,
  calls: number, missingUsage: number,
}
export function summarizeUsage(values: readonly (JudgeUsage | undefined)[]): UsageSummary {
  const result: UsageSummary = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: values.length, missingUsage: 0 }
  for (const usage of values) {
    if (usage === undefined || usage.inputTokens === undefined || usage.outputTokens === undefined) result.missingUsage++
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const) {
      const value = usage?.[key]
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error('Invalid token usage')
      result[key] += value ?? 0
    }
  }
  return result
}
export function priceUsage(usage: UsageSummary, prices: Prices): number | null {
  for (const value of [prices.input, prices.cacheRead, prices.cacheWrite, prices.output, ...(prices.reasoning === 'included' ? [] : [prices.reasoning])]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Prices must be finite nonnegative USD per million tokens')
  }
  if (usage.missingUsage > 0) return null
  return (usage.inputTokens * prices.input + usage.cacheReadTokens * prices.cacheRead + usage.cacheWriteTokens * prices.cacheWrite
    + usage.outputTokens * prices.output + (prices.reasoning === 'included' ? 0 : usage.reasoningTokens * prices.reasoning)) / 1_000_000
}
export function percentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null
}
export interface RunSample {
  task: string, arm: string, judgeBackend: string, repetition: number, success: boolean, durationMs: number, cleanupMs: number | null,
  main: UsageSummary, judge: UsageSummary, mainUsd: number | null, judgeUsd: number | null,
  judgeP50: number | null, judgeP95: number | null, ttftP50: number | null, ttftP95: number | null,
  reads: number, archiveReads: number, reductions: number, applied: number, estimatedSavedChars: number,
}
export function ledgerMetrics(records: readonly LedgerRecord[]): { judge: UsageSummary, judgeP50: number | null, judgeP95: number | null, applied: number, estimatedSavedChars: number } {
  const calls = records.filter(record => record.source !== 'rules')
  const delays = calls.flatMap(record => record.latencyMs === undefined ? [] : [record.latencyMs])
  const judge = summarizeUsage(calls.map(record => record.usage))
  judge.calls = calls.reduce((sum, record) => sum + (record.batch?.size ?? 1), 0)
  judge.missingUsage = calls.reduce((sum, record) => sum + (record.usage?.inputTokens === undefined || record.usage.outputTokens === undefined ? record.batch?.size ?? 1 : 0), 0)
  return { judge, judgeP50: percentile(delays, 0.5), judgeP95: percentile(delays, 0.95),
    applied: records.filter(record => record.applied === true).length, estimatedSavedChars: records.reduce((sum, record) => sum + (record.savedChars ?? 0), 0) }
}
export function compareRuns(samples: readonly RunSample[]): string {
  const groups = new Map<string, RunSample[]>()
  for (const sample of samples) { const key = `${sample.arm}/${sample.judgeBackend}`; groups.set(key, [...groups.get(key) ?? [], sample]) }
  const baseline = samples.filter(sample => sample.arm === 'off')
  const lines = ['# sieve 逐功能测量', '', '价格按输入未命中、缓存命中、缓存写入与输出分别计费；推理 token 单列，是否另计由价格文件声明。未知 usage 的费用记为缺失。shadow 字符估计不代表实际节省。', '',
    '| 对照臂/后端 | 成功/总数 | 主模型美元 | judge 美元 | 配对净省美元 | 结论 |', '|---|---:|---:|---:|---:|---|']
  const sumPrice = (runs: RunSample[], key: 'mainUsd' | 'judgeUsd'): number | null => runs.some(run => run[key] === null) ? null : runs.reduce((sum, run) => sum + (run[key] ?? 0), 0)
  const format = (value: number | null): string => value === null ? '缺失' : value.toFixed(6)
  for (const [key, runs] of groups) {
    const main = sumPrice(runs, 'mainUsd'), judge = sumPrice(runs, 'judgeUsd')
    const pairs = runs.map(run => baseline.find(base => base.task === run.task && base.repetition === run.repetition))
    const paired = pairs.every(run => run !== undefined) ? pairs as RunSample[] : []
    const baseMain = sumPrice(paired, 'mainUsd'), baseJudge = sumPrice(paired, 'judgeUsd')
    const saving = paired.length !== runs.length || main === null || judge === null || baseMain === null || baseJudge === null ? null : baseMain + baseJudge - main - judge
    const successes = runs.filter(run => run.success).length
    const baselineSuccesses = paired.filter(run => run.success).length
    const conclusion = runs[0]?.arm === 'off' ? '基线' : runs[0]?.arm === 'shadow' ? '只作筛选' : saving === null ? '证据缺失' : successes < baselineSuccesses ? '成功率下降' : saving > 0 ? '本次样本费用下降；需复测' : '无净收益'
    lines.push(`| ${key} | ${successes}/${runs.length} | ${format(main)} | ${format(judge)} | ${format(saving)} | ${conclusion} |`)
  }
  lines.push('', '逐次运行的输入分桶、输出/推理、补读次数、TTFT、judge 延迟、清理时间与应用次数见 samples.json；单次成功不能证明成功率相等。')
  return `${lines.join('\n')}\n`
}
