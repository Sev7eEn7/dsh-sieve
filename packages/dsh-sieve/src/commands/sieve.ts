/** Human session controls, with native command lifecycle records and no model turn. */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { Sieve } from '../index.ts'
import type { SieveJudgeStatus } from '../status.ts'
import { DECISION_IDS } from '../runtime/config.ts'
import type { DecisionId } from '../runtime/config.ts'
import { DECISION_MODES } from '../judge/decision.ts'
import type { DecisionMode } from '../judge/decision.ts'
import type { RewindRequest } from '../features/checkpoint/index.ts'
import type { RewindScope } from '../features/checkpoint/records.ts'

const USAGE = '/sieve status | mode <决策 id> <off|shadow|active|reset> | checkpoints | rewind [序号] [files|conversation|both] [preview|force] | rewind undo'

const SCOPES: ReadonlySet<string> = new Set<RewindScope>(['both', 'files', 'conversation'])

/** `rewind [n] [scope] [preview|force]` in any order; undefined for a word it does not know. */
export function parseRewind(words: readonly string[]): RewindRequest | undefined {
  let id: number | undefined
  let scope: RewindScope = 'both'
  let force = false
  let preview = false
  for (const word of words) {
    if (/^#?\d+$/.test(word)) id = Number(word.replace('#', ''))
    else if (SCOPES.has(word)) scope = word as RewindScope
    else if (word === 'force') force = true
    else if (word === 'preview') preview = true
    else return undefined
  }
  return { ...(id === undefined ? {} : { id }), scope, force, preview }
}

function judgeText(using: SieveJudgeStatus['using']): string {
  if (using.kind === 'laya') return 'Laya（本地）'
  if (using.kind === 'jev') return using.service === null ? 'Jev（profile 指定的端点）' : `Jev（${using.service}）`
  return '未配置。没有 Jev 密钥或 Laya 时 sieve 不改动任何上下文'
}

export function registerSieveCommand(ctx: Context, host: Sieve): void {
  ctx.commands.register({
    name: 'sieve',
    description: '查看 sieve 状态，设置当前会话的判断模式，列出检查点并回退',
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
          ...(status.checkpoint === undefined ? [] : [status.checkpoint.enabled
            ? `检查点：本会话 ${status.checkpoint.checkpoints} 个，回退 ${status.checkpoint.rewinds} 次${status.checkpoint.latest === null ? '' : `；最近 #${status.checkpoint.latest.id}（第 ${status.checkpoint.latest.turn} 回合）`}`
            : `检查点：${status.checkpoint.off ?? '关闭'}`]),
          ...status.decisions.map(decision =>
            `${decision.id}: ${decision.mode}；记录 ${decision.records}（规则 ${decision.rules}），已应用 ${decision.applied}，预计净省 ${decision.savedChars} 字符`),
          '模式覆盖仅在当前会话、本次插件装载期间有效。模式同时管规则精简与 judge：off 不改，shadow 只记账不改，active 才改写。',
        ].join('\n') }
      }
      if (args[0] === 'checkpoints' || args[0] === 'rewind') {
        const checkpoints = host.checkpoints
        if (checkpoints === undefined) return { kind: 'error', text: '检查点没有启用（checkpoint.enabled）。' }
        if (args[0] === 'checkpoints') return { kind: 'success', text: await checkpoints.listText(agent) }
        if (args[1] === 'undo' && args.length === 2) {
          const undone = await checkpoints.undo(agent, signal)
          return { kind: undone.ok ? 'success' : 'error', text: undone.text }
        }
        const request = parseRewind(args.slice(1))
        if (request === undefined) return { kind: 'error', text: USAGE }
        const rewound = await checkpoints.rewind(agent, request, signal)
        return { kind: rewound.ok ? 'success' : 'error', text: rewound.text }
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
