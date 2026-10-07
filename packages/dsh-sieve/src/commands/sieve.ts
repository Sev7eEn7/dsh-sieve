/** Human session controls, with native command lifecycle records and no model turn. */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { Sieve } from '../index.ts'
import type { SieveJudgeStatus } from '../status.ts'
import { DECISION_IDS } from '../runtime/config.ts'
import type { DecisionId } from '../runtime/config.ts'
import { DECISION_MODES } from '../judge/decision.ts'
import type { DecisionMode } from '../judge/decision.ts'

const USAGE = '/sieve status | mode <决策 id> <off|shadow|active|reset>'

function judgeText(using: SieveJudgeStatus['using']): string {
  if (using.kind === 'laya') return 'Laya（本地）'
  if (using.kind === 'jev') return using.service === null ? 'Jev（profile 指定的端点）' : `Jev（${using.service}）`
  return '未配置。没有 Jev 密钥或 Laya 时 sieve 不改动任何上下文'
}

export function registerSieveCommand(ctx: Context, host: Sieve): void {
  ctx.commands.register({
    name: 'sieve',
    description: '查看 sieve 状态，设置当前会话的判断模式',
    input: { hint: USAGE },
    handler: async ({ agent, rawInput, signal }): Promise<CommandResult> => {
      signal.throwIfAborted()
      const args = rawInput.trim().split(/\s+/).filter(Boolean)
      const sessionId = agent.session.header.id
      if (args.length === 0 || (args[0] === 'status' && args.length === 1)) {
        const status = host.status(sessionId, { recent: 0 })
        const judge = await host.judgeStatus()
        signal.throwIfAborted()
        return { kind: 'success', text: [
          `会话：${sessionId}`,
          `判断模型：${judgeText(judge.using)}`,
          `准入：${host.config.admission.enabled ? '开启' : '关闭'}；测试日志策略：${status.testLog}`,
          `账本：${status.recording ? '可用' : '未挂载'}；记录：${status.totals.records}；已应用：${status.totals.applied}`,
          `日志中带 sieve 标记的结果：${status.reducedResults ?? 0}`,
          ...status.decisions.map(decision =>
            `${decision.id}: ${decision.mode}；记录 ${decision.records}（规则 ${decision.rules}），已应用 ${decision.applied}，预计净省 ${decision.savedChars} 字符`),
          '模式覆盖仅在当前会话、本次插件装载期间有效。模式同时管规则精简与 judge：off 不改，shadow 只记账不改，active 才改写。',
        ].join('\n') }
      }
      const id = args[1] as DecisionId | undefined
      if (id === undefined || !DECISION_IDS.includes(id)) return { kind: 'error', text: `未知决策。${USAGE}` }
      if (args[0] === 'mode' && args.length === 3) {
        const mode = args[2]
        if (mode !== 'reset' && !DECISION_MODES.includes(mode as DecisionMode)) return { kind: 'error', text: `无效模式。${USAGE}` }
        host.setMode(sessionId, id, mode === 'reset' ? undefined : mode as DecisionMode)
        return { kind: 'success', text: `${id} 当前模式：${host.modeOf(id, sessionId)}` }
      }
      return { kind: 'error', text: USAGE }
    },
  })
}
