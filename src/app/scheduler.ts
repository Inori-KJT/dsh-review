/**
 * 调度器。它是运行状态的唯一写入者。
 *
 * 三条规则，全部可被测试验证：
 *   1 任何状态变化都先写库再写一条事件，界面与 HTTP 只能发请求，不能直接改状态。
 *   2 同一 (仓库, PR, 评审类型, head) 只有一条运行。重复提交返回既有运行，不新建。
 *   3 重启后从库里读 cursor 与已落库的发现，从该阶段继续，不从头重跑。
 *
 * 取消不是"杀进程"，而是给该运行置一个信号；阶段与适配器读到它就地停下，
 * 已提交的结果保留，运行记 cancelled。这样取消本身也是可审计的。
 */
import type { Depth, Finding, PublishMode, ReviewKind, Run, RunStatus, StageId, Vote } from '../core/model.ts'
import type { PriorFindingState, StorePort } from '../core/ports.ts'
import { newRun, runPipeline, type PipelineState, type RunDeps, type StageTable } from '../core/run.ts'
import { invariantCircuitBreaker, invariantOneRunPerHead } from '../core/invariants.ts'

export interface SubmitRequest {
  repo: string
  pr: number
  baseSha: string
  headSha: string
  repoPath: string
  since?: string
  depth?: Depth
  mode?: PublishMode
  reviewKind?: ReviewKind
  round?: number
  trigger?: Run['trigger']
}

export interface SubmitResult {
  runId: string
  reused: boolean
  /** 被熔断拦下时为 true，此时不新建运行。 */
  circuitOpen?: boolean
  reason?: string
}

export interface SchedulerOptions {
  store: StorePort
  deps: Omit<RunDeps, 'signal'>
  table: StageTable
  maxConcurrent?: number
  now?: () => number
  nextId?: () => string
}

interface Controller {
  aborted: boolean
}

export class Scheduler {
  private readonly store: StorePort
  private readonly deps: Omit<RunDeps, 'signal'>
  private readonly table: StageTable
  private readonly maxConcurrent: number
  private readonly now: () => number
  private readonly nextId: () => string
  private readonly controllers = new Map<string, Controller>()
  private readonly active = new Set<string>()
  private readonly paused = new Set<string>()
  private seq = 0

  constructor(options: SchedulerOptions) {
    this.store = options.store
    this.deps = options.deps
    this.table = options.table
    this.maxConcurrent = options.maxConcurrent ?? 4
    this.now = options.now ?? (() => Date.now())
    this.nextId = options.nextId ?? (() => `run-${(this.seq += 1).toString().padStart(4, '0')}-${this.now()}`)
  }

  /** 提交一次评审请求。重复的 head 返回既有运行；24 小时内超过六次则熔断。 */
  async submit(request: SubmitRequest): Promise<SubmitResult> {
    const reviewKind = request.reviewKind ?? 'bug'
    const existing = await this.store.findRunByHead(request.repo, request.pr, reviewKind, request.headSha)
    const duplicate = invariantOneRunPerHead(existing?.id)
    if (!duplicate.allowed) return { runId: existing!.id, reused: true, reason: duplicate.reason }

    const recent = await this.store.runsInLast24h(request.repo, request.pr, this.now())
    const breaker = invariantCircuitBreaker(recent)
    if (!breaker.allowed) return { runId: '', reused: false, circuitOpen: true, reason: breaker.reason }

    const state = newRun({
      id: this.nextId(),
      target: { kind: 'pr', repo: request.repo, pr: request.pr },
      repoPath: request.repoPath,
      repo: request.repo,
      pr: request.pr,
      baseSha: request.baseSha,
      headSha: request.headSha,
      since: request.since,
      depth: request.depth ?? 'standard',
      mode: request.mode ?? 'record',
      reviewKind,
      round: request.round ?? 1,
      trigger: request.trigger ?? 'manual',
      now: this.now(),
    })
    state.run.status = 'queued'
    await this.store.insertRun(state.run)
    await this.event(state.run.id, 'run.created', { repo: request.repo, pr: request.pr, head: request.headSha })
    return { runId: state.run.id, reused: false }
  }

  /** 推进一次运行，从库里的 cursor 开始。 */
  async start(runId: string): Promise<PipelineState | undefined> {
    return this.advance(runId)
  }

  /** 暂停。已落库的进度保留，恢复时从 cursor 继续。 */
  async pause(runId: string): Promise<void> {
    this.paused.add(runId)
    const run = await this.store.getRun(runId)
    if (!run) return
    run.status = 'paused'
    run.updatedAt = new Date(this.now()).toISOString()
    await this.store.updateRun(run)
    await this.event(runId, 'run.paused', {})
  }

  /** 取消。给运行置信号，阶段与适配器读到就停，已提交结果保留。 */
  async cancel(runId: string): Promise<void> {
    const controller = this.controllers.get(runId)
    if (controller) controller.aborted = true
    else this.controllers.set(runId, { aborted: true })
    const run = await this.store.getRun(runId)
    if (!run) return
    run.status = 'cancelled'
    run.updatedAt = new Date(this.now()).toISOString()
    await this.store.updateRun(run)
    await this.event(runId, 'run.cancelled', {})
  }

  /** 从指定阶段重跑。已落库的阶段记录保留，新增 attempt。 */
  async rerunFrom(runId: string, stage: StageId): Promise<PipelineState | undefined> {
    await this.event(runId, 'run.rerun', { from: stage })
    return this.advance(runId, stage)
  }

  /**
   * 重启后恢复。找出所有停在 running / queued 的运行，各自从 cursor 继续。
   * 返回恢复的运行 id 列表，便于调用方记录。
   */
  async resumeAfterRestart(): Promise<string[]> {
    const candidates = await this.store.listRuns({ statuses: ['running', 'queued'] })
    const resumed: string[] = []
    for (const run of candidates) {
      await this.event(run.id, 'run.resumed', { cursor: run.cursor })
      this.controllers.delete(run.id)
      await this.advance(run.id)
      resumed.push(run.id)
    }
    return resumed
  }

  /** 运行详情，供面板与测试查询。 */
  async inspect(runId: string): Promise<{ run: Run | undefined; findings: Finding[]; votes: Vote[]; stages: unknown[]; events: unknown[] }> {
    const run = await this.store.getRun(runId)
    const findings = await this.store.listFindings(runId)
    const votes: Vote[] = []
    for (const finding of findings) votes.push(...await this.store.listVotes(finding.id))
    return { run, findings, votes, stages: await this.store.listStages(runId), events: await this.store.listEvents(runId) }
  }

  private async advance(runId: string, from?: StageId): Promise<PipelineState | undefined> {
    const run = await this.store.getRun(runId)
    if (!run) return undefined
    if (run.status === 'cancelled' || run.status === 'done' || run.status === 'needs_human') return undefined
    if (this.paused.has(runId)) return undefined
    if (this.active.size >= this.maxConcurrent) {
      await this.event(runId, 'run.queued', { active: this.active.size })
      return undefined
    }

    // 恢复：把已落库的发现与投票读回内存态，避免重跑之前的阶段。
    const persistedFindings = await this.store.listFindings(runId)
    const state = newRun({
      id: run.id,
      target: run.target,
      repoPath: run.repoPath,
      repo: run.repo,
      pr: run.pr,
      baseSha: run.baseSha,
      headSha: run.headSha,
      since: run.since,
      depth: run.depth,
      mode: run.mode,
      reviewKind: run.reviewKind,
      round: run.round,
      configRevision: run.configRevision,
      trigger: run.trigger,
      now: this.now(),
    })
    state.run.cursor = from ?? run.cursor
    state.run.status = 'running'
    state.findings = persistedFindings
    // 恢复 collect / plan 的产物，否则从 plan 起会认为"没有 diff"而停下。
    const progress = await this.store.loadProgress(runId)
    if (progress) {
      try {
        const saved = JSON.parse(progress) as Partial<PipelineState>
        if (saved.diff) state.diff = saved.diff
        if (saved.baseRules) state.baseRules = saved.baseRules
        state.ruleFilesTouched = saved.ruleFilesTouched ?? []
        state.oversized = saved.oversized ?? false
        state.selectedPaths = saved.selectedPaths ?? []
        state.skippedPaths = saved.skippedPaths ?? []
        state.notes = (saved.notes ?? []).concat(state.notes)
      } catch { await this.event(runId, 'run.progressUnreadable', {}) }
    }
    for (const finding of persistedFindings) {
      state.votes.push(...await this.store.listVotes(finding.id))
    }
    await this.loadPriorFindings(state)

    const controller: Controller = this.controllers.get(runId) ?? { aborted: false }
    this.controllers.set(runId, controller)
    this.active.add(runId)

    try {
      // 阶段执行记录：每次尝试一行，重跑就是 attempt 递增，旧行不覆盖。
      const attempts = new Map<string, number>()
      for (const exec of await this.store.listStages(runId)) {
        attempts.set(exec.stage, Math.max(attempts.get(exec.stage) ?? 0, exec.attempt))
      }
      let previousUsed = { sessions: 0, turns: 0, elapsedMs: 0 }
      const result = await runPipeline(state, { ...this.deps, signal: controller }, this.table, {
        from: from ?? run.cursor,
        afterStage: async (stage, current) => {
          await this.persist(current)
          const attempt = (attempts.get(stage) ?? 0) + 1
          attempts.set(stage, attempt)
          // 按阶段记增量，不是累计值；否则无法从表里看出哪一阶段花了多少。
          const delta = {
            sessions: current.used.sessions - previousUsed.sessions,
            turns: current.used.turns - previousUsed.turns,
            durationMs: Math.max(0, current.used.elapsedMs - previousUsed.elapsedMs),
          }
          previousUsed = { sessions: current.used.sessions, turns: current.used.turns, elapsedMs: current.used.elapsedMs }
          const sessionIds = current.findings
            .map(finding => finding.finderSessionId)
            .filter((id): id is string => typeof id === 'string')
          await this.store.recordStage({
            runId,
            stage,
            attempt,
            status: 'done',
            startedAt: new Date(current.startedAt).toISOString(),
            endedAt: new Date(this.now()).toISOString(),
            sessionIds,
            usage: delta,
          })
          await this.event(runId, 'stage.done', { stage, attempt, status: current.run.status, usage: delta })
        },
      })
      await this.persist(result)
      await this.event(runId, 'run.finished', { status: result.run.status, notes: result.notes })
      return result
    } finally {
      this.active.delete(runId)
    }
  }

  /** 把内存态写回库。发现与投票按主键覆盖，因此可重复调用。 */
  private async persist(state: PipelineState): Promise<void> {
    state.run.updatedAt = new Date(this.now()).toISOString()
    await this.store.updateRun(state.run)
    await this.store.saveProgress(state.run.id, JSON.stringify({
      diff: state.diff,
      baseRules: state.baseRules,
      ruleFilesTouched: state.ruleFilesTouched,
      oversized: state.oversized,
      selectedPaths: state.selectedPaths,
      skippedPaths: state.skippedPaths,
      notes: state.notes,
    }))
    for (const finding of state.findings) {
      await this.store.insertFinding(finding)
    }
    for (const vote of state.votes) {
      await this.store.insertVote(vote)
    }
  }

  private async loadPriorFindings(state: PipelineState): Promise<void> {
    const fingerprints = new Set(state.findings.map(finding => finding.fingerprint))
    for (const fingerprint of fingerprints) {
      const prior = await this.store.priorFindingState(state.run.repo, state.run.pr, fingerprint)
      if (prior) state.priorFindings.set(fingerprint, prior as PriorFindingState)
    }
  }

  private async event(runId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    await this.store.appendEvent({ runId, at: new Date(this.now()).toISOString(), type, payload })
  }
}
