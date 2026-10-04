/**
 * `tool.admission`: what a chunk of tool output is, so confident noise can be
 * archived instead of entering the context. Tokens that never enter the
 * context are the cheapest ones, and keeping them out costs no prompt cache.
 *
 * The question asks what a chunk IS, not whether it is relevant to the agent's
 * intent. Measured in mu on a local judge: the relational form called every
 * chunk relevant, noise included, while this classification put 4 of 4 noise
 * chunks and 3 of 3 errors in the right class.
 *
 * Only a confident noise class drops a chunk. The caller archives whatever it
 * drops and leaves a pointer, which keeps a wrong verdict recoverable.
 *
 * Ported from mu `packages/kyrn-judge/src/decisions/tool-admission.ts` (MIT,
 * see THIRD_PARTY_NOTICES.md); wording, ids and versions unchanged.
 * @module
 */

import { defineDecision } from '../decision.ts'
import { pickChoice } from '../policy.ts'
import type { Answer, Question, Questions } from '../types.ts'

export interface AdmissionInput {
  /** The call that produced the output, e.g. the shell command. */
  readonly call: string
  readonly chunk: string
}

export type AdmissionKind = 'error' | 'result' | 'progress' | 'warning' | 'passing'

export type AdmissionOutcome = {
  readonly kind: AdmissionKind | 'unknown'
  readonly drop: boolean
}

const KINDS: readonly AdmissionKind[] = ['error', 'result', 'progress', 'warning', 'passing']
const NOISE: readonly AdmissionKind[] = ['progress', 'warning', 'passing']

/** The one question, about the chunk held in `field` of the state. */
function kindQuestion(field: string): Question {
  return {
    type: 'choice',
    instructions: `What kind of output is \`${field}\`?`,
    criteria: {
      error: 'An error, a failure or a stack trace',
      result: 'Search results, file contents or data',
      progress: 'Progress, downloads or build status',
      warning: 'Repeated warnings or deprecation notices',
      passing: 'Tests or checks that passed',
      other: 'Something else',
    },
  }
}

function outcomeOf(answer: Answer | undefined): AdmissionOutcome {
  if (answer?.type !== 'choice') return { kind: 'unknown', drop: false }
  const picked = pickChoice(answer)
  const kind = KINDS.find(known => known === picked) ?? 'unknown'
  return { kind, drop: kind !== 'unknown' && NOISE.includes(kind) }
}

export const toolAdmission = defineDecision({
  id: 'tool.admission',
  version: 2,
  cacheImpact: 'none',
  latency: 'inline',
  questions: { kind: kindQuestion('chunk') },
  // The chunk is the long field, so it goes last: a bounded-window judge cuts the tail.
  buildState(input: AdmissionInput) {
    return { call: input.call, chunk: input.chunk }
  },
  policy(answers): AdmissionOutcome {
    return outcomeOf(answers.kind)
  },
  fallback(): AdmissionOutcome {
    return { kind: 'unknown', drop: false }
  },
})

/**
 * The same classification for many chunks of one output in a single request:
 * the chunks sit in the state as `c1`, `c2`, … and each has its own question.
 * The state is billed once, and the verdicts come back together. Measured on
 * Jev in mu (2026-09-23): 16 chunks in 0.44 s and 7.6k tokens, against 1.4 s
 * and 11.6k tokens as 16 requests, with the same verdicts.
 */
export interface AdmissionBatchInput {
  readonly call: string
  readonly chunks: readonly string[]
}

export function chunkField(index: number): string {
  return `c${index + 1}`
}

function chunkQuestionId(index: number): string {
  return `k${index + 1}`
}

export const toolAdmissionBatch = defineDecision({
  id: 'tool.admission',
  version: 3,
  cacheImpact: 'none',
  latency: 'inline',
  questions: {} as Questions,
  questionsFor(input: AdmissionBatchInput): Questions {
    return Object.fromEntries(input.chunks.map((_, index) => [chunkQuestionId(index), kindQuestion(chunkField(index))]))
  },
  buildState(input: AdmissionBatchInput) {
    const state: Record<string, string> = { call: input.call }
    input.chunks.forEach((chunk, index) => {
      state[chunkField(index)] = chunk
    })
    return state
  },
  policy(answers, input): readonly AdmissionOutcome[] {
    const byId = answers as Readonly<Record<string, Answer | undefined>>
    return input.chunks.map((_, index) => outcomeOf(byId[chunkQuestionId(index)]))
  },
  fallback(input): readonly AdmissionOutcome[] {
    return input.chunks.map(() => ({ kind: 'unknown', drop: false }))
  },
})
