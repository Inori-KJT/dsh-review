/**
 * 流水线编排。作用是把九个阶段按预设串起来，并把状态集中在一处。
 *
 * 设计上只有 Scheduler 能改运行状态（T3 引入）。T2 阶段只有一个内存态，
 * 由 runPipeline 顺序推进，目的是先证明阶段之间的数据契约是对的。
 */
import type { Depth, Finding, Run, RunTarget, ReviewKind, PublishMode, Severity, StageId, Vote } from './model.ts'
import type { AgentRunner, DiffSummary, ForgePort, SubmittedFinding, VcsPort } from './ports.ts'
import type { CancelSignal } from './stage.ts'
import { PRESETS, type DepthPreset } from './pipeline.ts'
import { emptyUsed, type BudgetUsed } from './budget.ts'

/** 从 base 版本读到的规则文件快照。规则只信 base，不信 PR head。 */
export interface RuleSnapshot {
  agentsMd?: string
  reviewMd?: string
  /** 有哪些规则文件存在。 */
  present: string[]
}

/** 一次运行的全部中间状态。阶段读写它，编排只负责顺序。 */
export interface PipelineState {
  run: Run
  repoPath: string
  startedAt: number
  used: BudgetUsed

  /** collect 产出。 */
  diff?: DiffSummary
  baseRules?: RuleSnapshot
  /** PR 是否改动了规则文件；是则生成一条 held 发现。 */
  ruleFilesTouched: string[]
  /** 该 PR 已发布过的指纹及其状态，collect 时载入。 */
  priorFindings: Map<string, 'open' | 'false-positive' | 'intended' | 'unimportant' | 'resolved' | 'dismissed'>

  /** plan 产出。 */
  oversized: boolean
  selectedPaths: string[]
  skippedPaths: string[]

  /** find 产出。 */
  submitted: SubmittedFinding[]

  /** dedupe 起产出，后续阶段逐步改状态。 */
  findings: Finding[]

  /** verify 产出。 */
  votes: Vote[]

  /** gate 产出：等人在面板上处置的发现 id。 */
  gateWaiting: string[]

  /** publish 产出：本次真正会发出去（或记录）的发现。 */
  published: Finding[]

  /** 预算耗尽或阶段跳过的说明，供摘要与面板显示。 */
  notes: string[]
  overflow: boolean
}

export interface RunDeps {
  vcs: VcsPort
  forge: ForgePort
  agents: AgentRunner
  /** 取消信号。Scheduler 为每次运行造一个，传进来；阶段与适配器都可读它。 */
  signal?: CancelSignal
}

export type StageFn = (state: PipelineState, deps: RunDeps, preset: DepthPreset) => Promise<string | undefined>

/** 流水线的可选参数。 */
export interface PipelineOptions {
  /** 从哪个阶段开始，供重启后从 cursor 恢复与"从某阶段重跑"。 */
  from?: StageId
  /** 每个阶段结束后回调，供 Scheduler 持久化 cursor 与写事件。 */
  afterStage?: (stage: StageId, state: PipelineState) => Promise<void>
}

/** 新建一次运行的初始状态。 */
export function newRun(input: {
  id: string
  target: RunTarget
  repoPath: string
  repo: string
  pr: number
  baseSha: string
  headSha: string
  since?: string
  depth: Depth
  mode: PublishMode
  reviewKind?: ReviewKind
  round?: number
  configRevision?: number
  trigger?: Run['trigger']
  priorFindings?: Map<string, PipelineState['priorFindings'] extends Map<string, infer V> ? V : never>
  now?: number
}): PipelineState {
  const now = input.now ?? Date.now()
  const at = new Date(now).toISOString()
  const run: Run = {
    id: input.id,
    target: input.target,
    repo: input.repo,
    repoPath: input.repoPath,
    pr: input.pr,
    baseSha: input.baseSha,
    headSha: input.headSha,
    since: input.since,
    reviewKind: input.reviewKind ?? 'bug',
    depth: input.depth,
    mode: input.mode,
    round: input.round ?? 1,
    status: 'queued',
    cursor: 'collect',
    configRevision: input.configRevision ?? 1,
    trigger: input.trigger ?? 'manual',
    usage: { sessions: 0, turns: 0, durationMs: 0 },
    createdAt: at,
    updatedAt: at,
  }
  return {
    run,
    repoPath: input.repoPath,
    startedAt: now,
    used: emptyUsed(),
    ruleFilesTouched: [],
    priorFindings: input.priorFindings ?? new Map(),
    oversized: false,
    selectedPaths: [],
    skippedPaths: [],
    submitted: [],
    findings: [],
    votes: [],
    gateWaiting: [],
    published: [],
    notes: [],
    overflow: false,
  }
}

/** 阶段实现表。由各 stages 文件填充，避免 run.ts 反向依赖具体阶段。 */
export type StageTable = Partial<Record<string, StageFn>>

/**
 * 顺序执行该档位启用的阶段。任一阶段返回 waiting 时停下并标记运行状态。
 *
 * 两个可选行为：
 *   options.from       从该阶段开始，供重启后从 cursor 恢复与"从某阶段重跑"；
 *   options.afterStage 每个阶段结束后回调，供 Scheduler 持久化 cursor 与写事件。
 */
export async function runPipeline(
  state: PipelineState,
  deps: RunDeps,
  table: StageTable,
  options: PipelineOptions = {},
): Promise<PipelineState> {
  const preset = PRESETS[state.run.depth]
  state.run.status = 'running'
  const order = preset.stages
  const startIndex = options.from ? Math.max(0, order.indexOf(options.from)) : 0
  for (const stage of order.slice(startIndex)) {
    // 取消信号：一旦置位就停在当前阶段，运行记 cancelled。
    if (deps.signal?.aborted) {
      state.run.status = 'cancelled'
      state.notes.push(`在 ${stage} 之前收到取消信号`)
      finish(state)
      return state
    }
    const fn = table[stage]
    if (!fn) continue
    state.run.cursor = stage
    const waitingReason = await fn(state, deps, preset)
    await options.afterStage?.(stage, state)
    if (waitingReason) {
      state.run.status = 'waiting'
      state.notes.push(`${stage} 停下等人：${waitingReason}`)
      return state
    }
    if (state.overflow) {
      state.run.status = 'partial'
      state.notes.push('预算耗尽，未核实的发现标 unverified，不进入发布')
      finish(state)
      return state
    }
  }
  if (state.gateWaiting.length > 0 && preset.gate) {
    state.run.status = 'waiting'
  } else {
    state.run.status = 'done'
  }
  finish(state)
  return state
}

function finish(state: PipelineState): void {
  const now = Date.now()
  state.run.usage = {
    sessions: state.used.sessions,
    turns: state.used.turns,
    durationMs: now - state.startedAt,
  }
  state.run.updatedAt = new Date(now).toISOString()
}

/** 该轮允许的严重度，供 classify 过滤。 */
export function allowedSeverities(round: number): Severity[] {
  return round >= 3 ? ['important'] : ['important', 'nit']
}
