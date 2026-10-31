/**
 * `swarm.routing`: which model a sub-agent runs on and how hard it thinks,
 * and, when roles are offered, which role takes the task. A sub-agent starts
 * with an empty context, so these are chosen per task at no prompt-cache
 * cost. This is where cheap models can take the mechanical work.
 *
 * Ported from mu `packages/kyrn-judge/src/decisions/swarm-routing.ts`.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * Questions and policy are mu's, so the version stays mu's.
 * @module
 */

import { defineDecision } from '../decision.ts'
import { pickChoice } from '../policy.ts'
import type { Questions } from '../types.ts'

export interface RoutingInput {
  readonly task: string
  /** Roles to choose from: name -> what kind of task it takes. Empty or absent means the role is already settled. */
  readonly agents?: Readonly<Record<string, string>> | undefined
}

export type Thinking = 'low' | 'medium' | 'high'

export type RoutingOutcome = {
  /** 0 = cheapest model of the ladder, 1 = strongest. */
  readonly strength: number
  readonly thinking: Thinking
  /** The role that fits, or null when none clearly does and the default role should take it. */
  readonly agent: string | null
}

const SCORES = {
  difficulty: {
    type: 'score',
    instructions: 'How hard is `task`?',
    criteria: [
      'Mechanical, no judgment needed',
      'Routine engineering',
      'Needs careful design',
      'Hard even for an expert',
    ],
  },
  reasoning: {
    type: 'score',
    instructions: 'How much reasoning does `task` need?',
    criteria: ['Almost none', 'Some', 'A lot', 'Deep multi-step reasoning'],
  },
} satisfies Questions

export const swarmRouting = defineDecision({
  id: 'swarm.routing',
  version: 2,
  questions: SCORES as Questions,
  questionsFor(input: RoutingInput): Questions {
    if (input.agents === undefined || Object.keys(input.agents).length === 0) return SCORES
    return {
      agent: {
        type: 'choice',
        instructions: 'What kind of work is `task`?',
        criteria: { ...input.agents, other: 'None of these' },
      },
      ...SCORES,
    }
  },
  buildState(input: RoutingInput) {
    return { task: input.task }
  },
  policy(answers): RoutingOutcome {
    const { agent, difficulty, reasoning } = answers
    const hardness = difficulty?.type === 'score' ? difficulty.score : 1.5
    const depth = reasoning?.type === 'score' ? reasoning.score : 1.5
    return {
      strength: Math.min(1, Math.max(0, hardness / 3)),
      thinking: depth >= 2.2 ? 'high' : depth >= 1.1 ? 'medium' : 'low',
      agent: agent?.type === 'choice' ? (pickChoice(agent, { minProbability: 0.5 }) ?? null) : null,
    }
  },
  fallback(): RoutingOutcome {
    return { strength: 0.5, thinking: 'medium', agent: null }
  },
})

/** The model a task's difficulty maps to on a ladder ordered from cheapest to strongest. */
export function pickModel(ladder: readonly string[], strength: number): string | undefined {
  if (ladder.length === 0) return undefined
  return ladder[Math.round(Math.min(1, Math.max(0, strength)) * (ladder.length - 1))]
}
