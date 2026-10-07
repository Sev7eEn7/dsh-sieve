/** DSH post-execute admission: bounded judgments, durable originals, content-only replacements. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SpillRef } from '@deepseek-ai/dsh-spill'
import type { PostToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { isTestLog, planTestLog, renderTestLogBody, testLogSelection } from '../judge/admission/test-log.ts'
import { toolAdmissionBatch } from '../judge/decisions/tool-admission.ts'
import type { AdmissionOutcome } from '../judge/decisions/tool-admission.ts'
import type { Decision, DecisionEngine } from '../judge/engine.ts'
import type { LedgerAnnotation } from '../judge/ledger.ts'
import type { ResolvedConfig } from '../runtime/config.ts'
import { deadline, untilAbort } from '../runtime/operations.ts'
import { isSieveResult, SessionRuntime, textOf } from '../runtime/session-state.ts'
import type { AdmissionRewrite } from '../runtime/session-state.ts'
import { chunkLines, dedupAgainst, describeCall, foldSimilarLines, FULL_OUTPUT_REQUEST, judgeCandidates } from './admission-rules.ts'
import type { RuleResult, VisibleOutput } from './admission-rules.ts'
import { FORGET_STATE_KEY } from './forgetting.ts'

export interface AdmissionHost {
  readonly config: ResolvedConfig
  engineFor(agent: Agent): DecisionEngine
  annotate(sessionId: SessionId, ledgerId: string, patch: LedgerAnnotation): Promise<void>
  track<T>(work: Promise<T>): Promise<T>
  revisionOf(sessionId: SessionId): number
  /** Whether a judge model (Jev or Laya) is configured; without one no decision changes anything. */
  judgeReady(): Promise<boolean>
}

/**
 * Stands in for the archive pointer when a saving is estimated, so shadow,
 * where nothing is archived, and active estimate alike.
 */
const ESTIMATE_LOCATOR = '<archive>'
/** Chunks of one output asked about in one judge request. */
const CHUNKS_PER_REQUEST = 16

function parseArguments(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}

/** The body followed by the one pointer to the archived original, and the retrieval hint. */
function withPointer(body: string, locator: string, hint: string): string {
  return `${body}${body.endsWith('\n') ? '' : '\n'}[sieve: full output: ${locator}]\n${hint === '' ? '' : `${hint}\n`}`
}

export function registerAdmission(ctx: Context, host: AdmissionHost, runtime: SessionRuntime): void {
  const receipts = new WeakMap<ToolExecution, AdmissionRewrite>()
  const config = host.config.admission
  const sources = new WeakMap<object, readonly VisibleOutput[]>()

  ctx.on('tools/result', (exec, result) => {
    const receipt = receipts.get(exec)
    if (receipt === undefined) return
    receipts.delete(exec)
    // An outer finalizer may have replaced the rewrite; then nothing of it reached the model.
    const survived = !result.isError && textOf(result.content) === receipt.replacement
    for (const { id, changed } of receipt.records) void host.track(host.annotate(receipt.sessionId, id, { applied: changed && survived }))
  })

  /** Earlier results the model still sees. The forgetting projection keeps them, minus whatever was replaced since. */
  const visibleOutputs = (agent: Agent): readonly VisibleOutput[] => {
    const state = ctx.sessionProjections.stateOf(agent.session, FORGET_STATE_KEY)
    if (state === undefined) return []
    const cached = sources.get(state.candidates)
    if (cached !== undefined) return cached
    const outputs = state.candidates.map(candidate => ({
      callId: candidate.data.message.toolCallId,
      label: candidate.call === null ? 'tool' : describeCall(candidate.call.name, parseArguments(candidate.call.arguments)),
      text: textOf(candidate.data.message.content),
    }))
    sources.set(state.candidates, outputs)
    return outputs
  }

  const transform = async (exec: ToolExecution, agent: Agent, original: string): Promise<AdmissionRewrite | undefined> => {
    const state = runtime.for(agent)
    const task = runtime.task(agent)
    if (task === undefined) return undefined
    const sessionId = agent.session.header.id
    const revision = task.revision
    const settingsRevision = host.revisionOf(sessionId)
    const origin = { callId: exec.callId, rootCallId: exec.rootCallId, toolName: exec.name, userMessageId: task.userMessageId, nested: exec.parent !== undefined }
    const goal = [...new Set([task.firstUser, task.lastUser].filter(Boolean))].join('\n')
    const intent = task.lastAssistant.slice(0, 400)
    if (FULL_OUTPUT_REQUEST.test(`${task.lastUser}\n${intent}`)) return undefined

    const engine = state.engine
    const args = typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments as Record<string, unknown> : {}
    const command = exec.name === 'bash' && typeof args['command'] === 'string' ? args['command'] : undefined
    // File content gets only the lossless reference to text the model already has.
    const content = config.contentTools.includes(exec.name)
    const testLog = !content && command !== undefined && config.testLog !== 'off' && isTestLog(`bash: ${command}`, original)
    // The mode governs the rules as much as the judge: off leaves the output alone, shadow only measures.
    const mode = engine.modeOf(testLog ? testLogSelection.id : toolAdmissionBatch.id)
    if (mode === 'off' || !await host.judgeReady()) return undefined

    /** A replacement must save at least this much, after its markers and pointer. */
    const floor = Math.max(config.minNetChars, original.length * config.minNetShare)
    const saved = (text: string): number => original.length - text.length
    // A nested PTC call's content goes to a program, which cannot follow a reference to the model's context.
    const outputs = config.dedup && exec.parent === undefined ? visibleOutputs(agent) : undefined
    // Numbered file lines never repeat inside one read, and file content is not referenced to itself.
    const dedup = (text: string): RuleResult => outputs === undefined ? { text, lines: 0 } : dedupAgainst(text, outputs, { self: !content })
    /** What the model sees for a body: the original when nothing changed or too little is saved. */
    const finish = (body: string, locator: string, hint: string): string => {
      if (body === original) return original
      const text = withPointer(body, locator, hint)
      return saved(text) >= floor ? text : original
    }
    // Cancellation, a new user request or a settings change void the work; the deadline only ends the wait.
    const cancel = AbortSignal.any([exec.signal, state.controller.signal])
    const valid = (): boolean => !cancel.aborted && runtime.task(agent)?.revision === revision && host.revisionOf(sessionId) === settingsRevision
    const bound = deadline(cancel, config.waitMs)
    const wait = bound.signal
    let archived: SpillRef | undefined
    const archive = (): Promise<SpillRef> => {
      const saving = host.track(ctx.spillStore.saveText({
        owner: { sessionId }, source: { kind: 'tool', toolName: exec.name, callId: exec.callId, label: 'sieve-original' },
        suggestedName: `${exec.name}-original.txt`, content: original,
      }))
      saving.then(ref => { archived = ref }, () => {})
      return saving
    }
    const annotate = (id: string, patch: LedgerAnnotation): void => {
      void host.track(host.annotate(sessionId, id, patch))
    }

    try {
      if (testLog) {
        const input = { call: `bash: ${command}`, goal, intent, output: original }
        // The rules need no judge; their plan is the baseline every other outcome builds on.
        const rules = await planTestLog(input, 'rules', engine, { origin })
        const bodyOf = (omitted: readonly string[]): RuleResult => {
          const folded = renderTestLogBody({ ...rules, omitted })
          const repeated = dedup(folded.text)
          return { text: repeated.text, lines: folded.omittedLines + repeated.lines }
        }
        const baseline = rules.omitted
        const rulesBody = bodyOf(baseline)
        const rulesSaved = saved(finish(rulesBody.text, ESTIMATE_LOCATOR, ''))
        const rulesId = rulesBody.text === original ? undefined : engine.recordRules(testLogSelection, {
          outcome: { omit: [...baseline], lines: rulesBody.lines },
          state: { call: input.call, units: rules.units.map(unit => ({ id: unit.id, kind: unit.kind, lines: unit.lines })) },
          origin, savedChars: rulesSaved, applied: false,
        })
        const judgeSaved = (judged: readonly string[] | undefined): number =>
          judged === undefined ? 0 : Math.max(0, saved(finish(bodyOf(judged).text, ESTIMATE_LOCATOR, '')) - rulesSaved)
        const judging = config.testLog !== 'judge' ? undefined : host.track(planTestLog(input, 'judge', engine, {
          // Shadow is never waited for, so only cancellation bounds it; the judge keeps its own deadline.
          signal: mode === 'shadow' ? cancel : wait, origin,
        }))
        let judgeId: string | undefined
        // Registered before anything waits on the plan, so its annotation is queued ahead of the applied flag.
        void judging?.then(plan => {
          if (plan.ledgerId === undefined) return
          judgeId = plan.ledgerId
          annotate(plan.ledgerId, { applied: false, savedChars: judgeSaved(plan.judged) })
        }).catch(() => {})
        if (mode === 'shadow') return undefined

        // Whatever the judge does, the rules result stands: archive for it while the judge thinks.
        const early = rulesSaved > 0 ? archive() : undefined
        let omitted = baseline
        if (judging !== undefined) {
          const plan = await untilAbort(judging, wait)
          // Late, failed or aborted: the rules result.
          if (plan !== undefined) omitted = plan.omitted
        }
        const body = bodyOf(omitted).text
        if (!valid() || finish(body, ESTIMATE_LOCATOR, '') === original) return undefined
        const ref = archived ?? await untilAbort(early ?? archive(), wait)
        if (ref === undefined || !valid()) return undefined
        const replacement = finish(body, ref.locator, ref.retrievalHint)
        if (replacement === original) return undefined
        const records: { id: string, changed: boolean }[] = []
        if (rulesId !== undefined) records.push({ id: rulesId, changed: true })
        if (judgeId !== undefined) records.push({ id: judgeId, changed: replacement !== finish(rulesBody.text, ref.locator, ref.retrievalHint) })
        return { sessionId, replacement, records }
      }

      // The rules: similar lines fold (never in file content), then repeats of what the model already has.
      const call = describeCall(exec.name, exec.arguments)
      const folded = content || !config.foldSimilar ? { text: original, lines: 0 } : foldSimilarLines(original, goal, intent)
      const repeated = dedup(folded.text)
      const rulesBody = repeated.text
      const rulesSaved = saved(finish(rulesBody, ESTIMATE_LOCATOR, ''))
      const rulesId = rulesBody === original ? undefined : engine.recordRules(toolAdmissionBatch, {
        outcome: { folded: folded.lines, repeated: repeated.lines },
        state: { call },
        origin, savedChars: rulesSaved, applied: false,
      })

      // The judge: middle chunks of a long output that is not file content, on top of the rules.
      const chunks = chunkLines(rulesBody, config.chunkChars)
      const indexes = content || rulesBody.length < config.judgeMinChars || chunks.length < 3 || chunks.length > config.maxChunks
        || goal.trim() === '' || intent.trim() === '' ? [] : judgeCandidates(chunks, goal, intent)
      const offered = indexes.reduce((sum, index) => sum + (chunks[index]?.length ?? 0), 0)
      // The marker and minimum recovery pointer already have to leave worthwhile savings.
      const judgeWorth = indexes.length > 0 && offered >= floor + 100
      const bodyWith = (omitted: ReadonlySet<number>): string => {
        if (omitted.size === 0) return rulesBody
        let text = ''
        let removed = 0
        const flush = (): void => {
          if (removed > 0) text += `${text.endsWith('\n') || text === '' ? '' : '\n'}[sieve: omitted ${removed} characters judged not needed for this step]\n`
          removed = 0
        }
        chunks.forEach((chunk, index) => {
          if (omitted.has(index)) removed += chunk.length
          else { flush(); text += chunk }
        })
        flush()
        return text
      }
      const dropped = (outcomes: readonly AdmissionOutcome[]): Set<number> =>
        new Set(indexes.filter((_index, position) => outcomes[position]?.drop === true))
      let judging: Promise<Decision<readonly AdmissionOutcome[]>[]> | undefined
      let judgeId: string | undefined
      if (judgeWorth) {
        const batches: { call: string, goal: string, intent: string, chunks: string[] }[] = []
        for (let start = 0; start < indexes.length; start += CHUNKS_PER_REQUEST) {
          batches.push({ call, goal, intent, chunks: indexes.slice(start, start + CHUNKS_PER_REQUEST).map(index => chunks[index] ?? '') })
        }
        judging = engine.decideMany(toolAdmissionBatch, batches, { signal: mode === 'shadow' ? cancel : wait, origin })
        void judging.then((decisions: Decision<readonly AdmissionOutcome[]>[]) => {
          const id = decisions[0]?.ledgerId
          if (id === undefined) return
          judgeId = id
          // What active would drop: the verdict where the judge answered, the fallback (keep) elsewhere.
          const verdict = dropped(decisions.flatMap(decision => decision.judged ?? decision.outcome))
          annotate(id, { applied: false, savedChars: Math.max(0, saved(finish(bodyWith(verdict), ESTIMATE_LOCATOR, '')) - rulesSaved) })
        }).catch(() => {})
      }
      // Shadow samples record their cost and estimate without delaying the model-facing result.
      if (mode === 'shadow') return undefined

      const early = rulesSaved > 0 ? archive() : undefined
      let omitted = new Set<number>()
      if (judging !== undefined) {
        const decisions = await untilAbort(judging, wait)
        // Late, failed or aborted: the rules result.
        if (decisions !== undefined && !decisions.some(decision => decision.reason?.startsWith('error:') === true)) {
          omitted = dropped(decisions.flatMap(decision => decision.outcome))
        }
      }
      const body = bodyWith(omitted)
      if (!valid() || finish(body, ESTIMATE_LOCATOR, '') === original) return undefined
      const ref = archived ?? await untilAbort(early ?? archive(), wait)
      if (ref === undefined || !valid()) return undefined
      const replacement = finish(body, ref.locator, ref.retrievalHint)
      if (replacement === original) return undefined
      const records: { id: string, changed: boolean }[] = []
      if (rulesId !== undefined) records.push({ id: rulesId, changed: true })
      if (judgeId !== undefined) records.push({ id: judgeId, changed: replacement !== finish(rulesBody, ref.locator, ref.retrievalHint) })
      return { sessionId, replacement, records }
    } finally {
      bound.dispose()
    }
  }

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    // Downstream exceptions and blocking decisions are not sieve failures.
    const decision = await next()
    const agent = exec.agent
    if (!config.enabled || decision.kind !== 'accept' || 'value' in decision || result.isError || exec.signal.aborted
      || agent === undefined || config.passThrough.includes(exec.name)) return decision
    const content = decision.content ?? result.content
    if (content.some(block => block.type !== 'text')) return decision
    const original = textOf(content)
    if (original.length < config.minChars || isSieveResult(original)) return decision
    const rewrite = await host.track(transform(exec, agent, original)).catch(() => {
      ctx.logger.warn('sieve: admission failed; keeping the original tool output')
      return undefined
    })
    if (rewrite === undefined) return decision
    receipts.set(exec, rewrite)
    return { ...decision, content: [{ type: 'text', text: rewrite.replacement }] }
  })
}
