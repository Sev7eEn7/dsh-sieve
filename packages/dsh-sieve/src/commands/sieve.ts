/** Human session controls, with native command lifecycle records and no model turn. */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { Sieve } from '../index.ts'
import { DECISION_IDS } from '../runtime/config.ts'
import type { DecisionId } from '../runtime/config.ts'
import { DECISION_MODES } from '../judge/decision.ts'
import type { DecisionMode } from '../judge/decision.ts'

const USAGE = '/sieve status | mode <决策 id> <off|shadow|active|reset> | route [<决策 id> <provider> <model>|<决策 id> reset]'

export function registerSieveCommand(ctx: Context, host: Sieve): void {
  ctx.commands.register({
    name: 'sieve',
    description: '查看 sieve 状态，设置当前会话的判断模式和模型路由',
    input: { hint: USAGE },
    handler: ({ agent, rawInput, signal }): CommandResult => {
      signal.throwIfAborted()
      const args = rawInput.trim().split(/\s+/).filter(Boolean)
      const sessionId = agent.session.header.id
      const routes = (): string => DECISION_IDS.map(id => {
        const route = host.routeOf(agent, id)
        return `${id}: ${route === undefined ? host.config.judge.type : `${route.provider}/${route.model}`}`
      }).join('\n')
      if (args.length === 0 || (args[0] === 'status' && args.length === 1)) {
        const status = host.status(sessionId, { recent: 0 })
        return { kind: 'success', text: [
          `会话：${sessionId}`,
          `准入：${host.config.admission.enabled ? '开启' : '关闭'}；测试日志策略：${status.testLog}`,
          `账本：${status.recording ? '可用' : '未挂载'}；记录：${status.totals.records}；已应用：${status.totals.applied}`,
          `日志中带 sieve 标记的结果：${status.reducedResults ?? 0}`,
          ...status.decisions.map(decision =>
            `${decision.id}: ${decision.mode}；记录 ${decision.records}（规则 ${decision.rules}），已应用 ${decision.applied}，预计净省 ${decision.savedChars} 字符`),
          routes(),
          '模式与路由覆盖仅在当前会话、本次插件装载期间有效。模式同时管规则精简与 judge：off 不改，shadow 只记账不改，active 才改写。',
        ].join('\n') }
      }
      if (args[0] === 'route' && args.length === 1) return { kind: 'success', text: routes() }
      const id = args[1] as DecisionId | undefined
      if (id === undefined || !DECISION_IDS.includes(id)) return { kind: 'error', text: `未知决策。${USAGE}` }
      if (args[0] === 'mode' && args.length === 3) {
        const mode = args[2]
        if (mode !== 'reset' && !DECISION_MODES.includes(mode as DecisionMode)) return { kind: 'error', text: `无效模式。${USAGE}` }
        host.setMode(sessionId, id, mode === 'reset' ? undefined : mode as DecisionMode)
        return { kind: 'success', text: `${id} 当前模式：${host.modeOf(id, sessionId)}` }
      }
      if (args[0] === 'route' && ((args.length === 3 && args[2] === 'reset') || args.length === 4)) {
        if (host.config.judge.type !== 'llm' && host.config.judge.type !== 'auto') return { kind: 'error', text: '当前 judge 不是 llm 或 auto，请先在 profile 配置中选择其一。' }
        host.setRoute(sessionId, id, args.length === 3 ? undefined : { provider: args[2] as string, model: args[3] as string })
        return { kind: 'success', text: routes() }
      }
      return { kind: 'error', text: USAGE }
    },
  })
}
