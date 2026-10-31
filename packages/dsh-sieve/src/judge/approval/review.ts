/**
 * One call under Jev approval, through the three layers: rules, `tool.risk`
 * for a flagged command, `tool.approval` for the rest. Only a sure yes runs a
 * call without the user; everything else, a judge that did not answer
 * included, asks. Host-free, so the gate (`src/features/approval/`) and the
 * offline evaluation replay the same code.
 *
 * The policy is mu's Jev mode (`packages/kyrn-judge/src/extension/features/permissions.ts`).
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * @module
 */

import type { Decision, DecisionEngine } from '../engine.ts'
import { toolApproval } from '../decisions/tool-approval.ts'
import { toolRisk } from '../decisions/tool-risk.ts'
import { clip } from '../hive/member.ts'
import { commandOf, isShellTool } from '../monitor/mutating.ts'
import { threeZone } from '../policy.ts'
import { FLAG_ZH, permissionNeed, riskFlag, sendsCredentials } from './rules.ts'
import type { PermissionNeed } from './rules.ts'

/**
 * Why the user is asked. `judgedown`: no judge answered. `notjudging`: the
 * decision runs in shadow or off in this session. `unvouched`: a sub-agent
 * whose user request could not be found.
 */
export type AskReason = 'unsure' | 'beyond' | 'unrelated' | 'flagged' | 'protected' | 'judgedown' | 'notjudging' | 'unvouched'

export type Review =
  | { readonly kind: 'allow', readonly need?: PermissionNeed | undefined, readonly judged?: string | undefined }
  | { readonly kind: 'deny', readonly need: PermissionNeed, readonly reason: string }
  | { readonly kind: 'ask', readonly need: PermissionNeed, readonly why: AskReason, readonly flag?: string | undefined }

export interface CallToReview {
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  /** The session's working directory; undefined counts every edit as outside the project. */
  readonly cwd: string | undefined
  /** The user's own words: the session's first and latest requests. Undefined when none vouch (a sub-agent without its parent). */
  readonly request: { readonly firstUser: string, readonly lastUser: string } | undefined
  readonly callId: string
}

export interface ReviewOptions {
  /** Folders whose every touch is the user's to allow (`harnessFolders`). */
  readonly folders: readonly string[]
  readonly signal?: AbortSignal | undefined
}

const REASON_TEXT: Readonly<Record<Exclude<AskReason, 'flagged'>, { readonly en: string, readonly zh: string }>> = {
  unsure: { en: 'Jev is not sure this step is what you want.', zh: 'Jev 拿不准这一步是不是你要的。' },
  beyond: { en: 'Jev thinks this goes beyond what you asked for.', zh: 'Jev 认为这一步超出了你的要求。' },
  unrelated: { en: 'Jev thinks this is not part of the task.', zh: 'Jev 认为这一步和当前任务无关。' },
  protected: { en: 'This touches DeepSeek Harness\'s own settings; only you can allow it.', zh: '这会动到 DeepSeek Harness 自己的设置，只能由你决定。' },
  judgedown: { en: 'The judge did not answer, so sieve asks you.', zh: '判定器没有回答，所以先问你。' },
  notjudging: { en: 'Jev approval only records in this session (shadow or off), so sieve asks you.', zh: '这个会话里 Jev 审批只记录不放行（shadow 或 off），所以先问你。' },
  unvouched: { en: 'This sub-agent\'s call has no request of yours to go by, so sieve asks you.', zh: '找不到你对这个子代理的原始要求，所以先问你。' },
}

const WHERE: Readonly<Record<PermissionNeed['kind'], string>> = {
  edit: 'a file in the project folder',
  shell: 'a program run in the project folder',
  outside: 'outside the project folder',
  delegate: 'sub-agents working on the project',
  other: 'an action outside this computer or program, such as a web page or a connected service',
}

/** What the user is shown when asked, in each language DSH's prompt can show. */
export function askText(summary: string, why: AskReason, flag?: string): { readonly en: string, readonly zh: string } {
  const reason = why === 'flagged'
    ? { en: `Risky: ${flag ?? 'flagged by a rule'}.`, zh: `危险操作：${FLAG_ZH[flag ?? ''] ?? flag ?? '规则标记'}。` }
    : REASON_TEXT[why]
  return { en: `sieve: ${summary}\n${reason.en}`, zh: `sieve：${summary}\n${reason.zh}` }
}

/** Why no judge's verdict decided a call, when none did. */
function unanswered(decision: Decision<unknown>): AskReason | undefined {
  if (decision.source === 'judge') return undefined
  return decision.reason === 'shadow' || decision.reason === 'off' ? 'notjudging' : 'judgedown'
}

/** "bash: npm test", "write src/a.ts": the call as the judge reads it. */
function callLine(name: string, input: Readonly<Record<string, unknown>>): string {
  const value = input['command'] ?? input['file_path'] ?? input['path'] ?? input['url'] ?? input['prompt']
  return `${name}: ${typeof value === 'string' ? value : JSON.stringify(input)}`
}

export async function reviewCall(call: CallToReview, engine: DecisionEngine, options: ReviewOptions): Promise<Review> {
  const need = permissionNeed(call.name, call.input, call.cwd, options.folders)
  if (need === undefined) return { kind: 'allow' }
  const origin = { callId: call.callId }
  const command = isShellTool(call.name) ? commandOf(call.input) : ''
  const sends = command === '' ? undefined : sendsCredentials(command)
  if (sends !== undefined) {
    engine.recordRules(toolRisk, { outcome: 'refuse', state: { command: clip(command, 400), flag: sends }, origin, applied: true })
    return { kind: 'deny', need, reason: `sieve: this command ${sends}; that is never approved for the user. Do not try another way around it: ask the user.` }
  }
  if (need.protected !== undefined) return { kind: 'ask', need, why: 'protected' }
  const flag = command === '' ? undefined : riskFlag(command)
  // Editing the project is the task itself, and a checkpoint can take it back.
  if (need.kind === 'edit' && need.inProject === true && flag === undefined) return { kind: 'allow', need }
  if (call.request === undefined) return { kind: 'ask', need, why: 'unvouched', flag }
  const userMessage = clip(call.request.lastUser, 400)
  const signal = options.signal
  if (flag !== undefined) {
    const decision = await engine.decide(toolRisk, { command: clip(command, 400), userMessage, flag }, { signal, applied: false, origin })
    // Only Jev being sure the user asked for it runs a flagged call: "not destructive" is read from the command itself.
    const requested = decision.answers?.['requested']
    const vouched = decision.source === 'judge' && decision.outcome === 'allow' && requested?.type === 'boolean' && threeZone(requested) === 'yes'
    return vouched ? { kind: 'allow', need, judged: decision.ledgerId } : { kind: 'ask', need, why: 'flagged', flag }
  }
  const { firstUser, lastUser } = call.request
  const task = firstUser !== '' && firstUser !== lastUser ? `${clip(firstUser, 300)} / now: ${clip(lastUser, 300)}` : userMessage
  const decision = await engine.decide(toolApproval, { task, userMessage, call: clip(callLine(call.name, call.input), 400), where: WHERE[need.kind] }, { signal, applied: false, origin })
  if (decision.source === 'judge' && decision.outcome === 'approve') return { kind: 'allow', need, judged: decision.ledgerId }
  const why = unanswered(decision) ?? (decision.outcome === 'approve' ? 'unsure' : decision.outcome)
  return { kind: 'ask', need, why }
}
