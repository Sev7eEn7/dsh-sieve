/**
 * The `llm` judge's model call through DSH `ctx.llm.stream()`: one auxiliary
 * request that never enters a session log (the same path DSH `auto-review`
 * uses for its reviewer). Usage comes from the stream's `TokenUsage`, cache
 * and reasoning counters included, so the ledger can price every judge call.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { JudgeError } from '../judge/errors.ts'
import type { LlmCompletion } from '../judge/providers/llm.ts'
import type { JudgeUsage } from '../judge/types.ts'
import type { LlmRoute } from './config.ts'

export interface LlmCompletionOptions {
  /** The route at call time: the configured one, or the session's own. */
  readonly route: () => LlmRoute | undefined
  readonly maxTokens: number
  /** Stamped on the request for routing metadata; never logged by sieve. */
  readonly sessionId?: SessionId | undefined
}

/** The route an agent's next request goes to: the logged request header, else its options. */
export function agentRoute(agent: Agent): LlmRoute | undefined {
  const routed = agent.session.requestHeader()?.config
  const provider = routed?.provider ?? agent.options.provider
  const model = routed?.model ?? agent.options.model
  return provider === undefined || model === undefined ? undefined : { provider, model }
}

export function judgeUsage(usage: TokenUsage | undefined): JudgeUsage | undefined {
  if (usage === undefined) return undefined
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens,
  }
}

/**
 * Bind the host-free LLM judge to `ctx.llm`.
 * @param ctx - context exposing the `llm` service.
 * @param options - route resolver, output cap and session stamp.
 * @returns the completion function `LlmJudgeProvider` calls.
 */
export function llmCompletion(ctx: Context, options: LlmCompletionOptions): LlmCompletion {
  return async ({ system, user, signal }) => {
    const route = options.route()
    if (route === undefined) {
      throw new JudgeError('auth', 'No model route for the llm judge: the session has none yet; set judge.provider and judge.model')
    }
    const request: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      temperature: 0,
      maxTokens: options.maxTokens,
      ...signal === undefined ? {} : { signal },
      ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
    }
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk)
    const finish = assembler.finish
    const usage = judgeUsage(assembler.usage)
    if (finish?.kind === 'aborted') throw signal?.reason ?? new Error('judge model call aborted')
    if (finish?.kind === 'error') {
      throw new JudgeError('unreachable', `judge model failed: ${finish.failure.code}: ${finish.failure.message}`, { usage })
    }
    if (finish?.kind !== 'stop') {
      // A reply cut at the output cap is paid for and unusable.
      throw new JudgeError('invalid_response', `judge model ended with ${finish?.kind ?? 'no finish'}`, { usage })
    }
    const text = assembler.blocks()
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
    return { text, usage, modelId: `${route.provider}/${route.model}` }
  }
}
