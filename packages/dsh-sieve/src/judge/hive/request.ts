/**
 * `/hive <question>`: a person starts a hive by asking a question. The main
 * model still plans the bees, since it knows the project and the angles, but
 * it is told to do so at once, in its first step, and never to ask anything
 * first: the question is the whole brief.
 *
 * Ported from mu `packages/kyrn-judge/src/hive/request.ts`.
 * Contains MIT-licensed third-party code, see THIRD_PARTY_NOTICES.md.
 * mu's `/hive` alone was its `/swarm`; sieve has no swarm, so alone it shows
 * the hive that is running.
 * @module
 */

/** What the text after `/hive` asks for. */
export type HiveArgs =
  /** Nothing, or "status": what the running hive is doing. */
  | { readonly kind: 'status' }
  /** "stop [name]" or "kill [name]": a bee, or the whole hive. */
  | { readonly kind: 'control', readonly verb: 'stop' | 'kill', readonly name?: string }
  | { readonly kind: 'question', readonly question: string }

/**
 * Alone, `/hive` shows the running hive, and "stop" or "kill" with at most a
 * bee's name controls it. Anything longer is a question, so "/hive stop
 * words: where are they defined?" starts a hive rather than stopping one.
 */
export function parseHiveArgs(args: string): HiveArgs {
  const text = args.trim()
  if (text === '' || text === 'status') return { kind: 'status' }
  const [verb, name, ...more] = text.split(/\s+/)
  if ((verb === 'stop' || verb === 'kill') && more.length === 0) {
    return { kind: 'control', verb, ...(name !== undefined && name !== '' ? { name } : {}) }
  }
  return { kind: 'question', question: text }
}

/**
 * The user message `/hive <question>` sends. The model reads it; the person
 * sees it in the chat, so it starts with the question. Three bees is the
 * default because two rarely have anything to pass each other and more than
 * four mostly repeat each other; the angles are ones whose findings bear on
 * each other, since that is what a hive is for.
 */
export function hiveRequest(question: string): string {
  return [
    `Question for a hive: ${question.trim()}`,
    '',
    'Call the `hive` tool now, as your first step: do not read anything first, and do not ask me anything.',
    '- goal: my question as I asked it, and what a complete answer to it must contain.',
    '- bees: three investigators (two for a narrow question, four for one with four separate parts). Give each a different angle on the same question, chosen so that what one finds can confirm, correct or advance what the others look at: where it is implemented, how it is configured or called, what running it or its tests shows, what the history or the documentation says. Name each after its angle.',
    '',
    'When the hive returns, answer my question from the reports and the board: the answer first, then the evidence (file:line, commands and what they printed). Rely most on findings that were confirmed or that corrected another, and say what stayed disputed or unverified. Answer in the language of my question.',
  ].join('\n')
}
