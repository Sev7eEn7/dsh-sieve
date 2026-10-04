/**
 * `skills.disclosure`: every installed skill costs a description in the
 * catalog of every session, whether or not the work will ever touch it. One
 * yes/no per skill decides which descriptions a session starts with.
 *
 * Only a confident "no" hides a skill, and hidden is not gone: the `skill`
 * tool still loads it.
 *
 * Ported from mu `packages/kyrn-judge/src/decisions/skill-disclosure.ts` (MIT,
 * see THIRD_PARTY_NOTICES.md); wording, id and version unchanged.
 * @module
 */

import { defineDecision } from '../decision.ts'
import { threeZone } from '../policy.ts'
import type { Answer, Questions } from '../types.ts'

export interface SkillCandidate {
  readonly name: string
  readonly description: string
}

export interface SkillDisclosureInput {
  readonly userMessage: string
  readonly skills: readonly SkillCandidate[]
}

export type SkillDisclosureOutcome = {
  /** Names of skills to leave out of the catalog. */
  readonly hide: readonly string[]
  /** Names the judge called relevant, for announcing a skill that was hidden earlier. */
  readonly relevant: readonly string[]
}

const DESCRIPTION_LENGTH = 220

export function skillQuestionId(index: number): string {
  return `skill_${index}`
}

export const skillDisclosure = defineDecision({
  id: 'skills.disclosure',
  version: 1,
  // Decided once, on the first message, when there is no cached prefix to lose.
  cacheImpact: 'prefix-mutating',
  latency: 'inline',
  questions: {} as Questions,
  questionsFor(input: SkillDisclosureInput): Questions {
    return Object.fromEntries(
      input.skills.map((skill, index) => [
        skillQuestionId(index),
        {
          type: 'boolean' as const,
          instructions: `Would this skill help with \`user_message\`? ${skill.name}: ${skill.description.slice(0, DESCRIPTION_LENGTH)}`,
        },
      ]),
    )
  },
  buildState(input: SkillDisclosureInput) {
    return { user_message: input.userMessage }
  },
  policy(answers, input): SkillDisclosureOutcome {
    const byId = answers as Readonly<Record<string, Answer | undefined>>
    const hide: string[] = []
    const relevant: string[] = []
    input.skills.forEach((skill, index) => {
      const answer = byId[skillQuestionId(index)]
      if (answer?.type !== 'boolean') return
      const verdict = threeZone(answer)
      if (verdict === 'no') hide.push(skill.name)
      if (verdict === 'yes') relevant.push(skill.name)
    })
    return { hide, relevant }
  },
  fallback(): SkillDisclosureOutcome {
    return { hide: [], relevant: [] }
  },
})
