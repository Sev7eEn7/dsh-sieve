/**
 * Deterministic judge for tests and offline development.
 *
 * Without a responder every answer is neutral, so decisions abstain and the
 * caller's fallback path runs. Partial responders are filled with neutral
 * answers.
 *
 * Ported from mu `packages/kyrn-judge/src/providers/mock.ts` (MIT, see THIRD_PARTY_NOTICES.md).
 * @module
 */

import { neutralAnswer } from '../policy.ts'
import type { Answer, JudgeProvider, JudgeRequest, JudgeUsage, ProviderResponse } from '../types.ts'

export type MockResponder = (
  request: JudgeRequest,
) => Readonly<Record<string, Answer>> | Promise<Readonly<Record<string, Answer>>>

export class MockJudgeProvider implements JudgeProvider {
  readonly id: string
  readonly calls: JudgeRequest[] = []
  private readonly responder: MockResponder | undefined
  private readonly usage: JudgeUsage

  constructor(responder?: MockResponder, id = 'mock', usage: JudgeUsage = { inputTokens: 0, outputTokens: 0 }) {
    this.responder = responder
    this.id = id
    this.usage = usage
  }

  async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
    this.calls.push(request)
    const scripted = this.responder === undefined ? {} : await this.responder(request)
    const answers: Record<string, Answer> = {}
    for (const [id, question] of Object.entries(request.questions)) {
      answers[id] = scripted[id] ?? neutralAnswer(question)
    }
    return { answers, usage: { ...this.usage }, modelId: 'mock' }
  }
}
