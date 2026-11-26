/**
 * 端口：core 与外部世界之间唯一的连接面。
 *
 * 每个端口对应一种可替换的实现，因此"变体是配置或适配器，不是分支"。
 * 后续阶段的接口在这里先声明出来，只写类型不写实现。
 */
import type {
  Category, CodeLocation, Depth, Feedback, Finding, ReviewKind, Run, RunEvent, RunStatus,
  RunTarget, Severity, StageExec, Vote,
} from './model.ts'
import type { FingerprintInput } from './fingerprint.ts'

/** 代码托管平台。v1 实现 GitCode，预留 GitHub。 */
export interface ForgePort {
  listPulls(query: { repo: string; state: 'open' | 'all'; updatedSince?: string }): Promise<PullSummary[]>
  getPull(repo: string, pr: number): Promise<PullDetail | undefined>
  listComments(repo: string, pr: number, since?: string): Promise<CommentSummary[]>
  /** 以下三个在 publish.mode 为 record 时必须抛 NotEnabled。 */
  postInline(repo: string, pr: number, finding: Finding): Promise<void>
  postSummary(repo: string, pr: number, body: string): Promise<void>
  setStatus(repo: string, sha: string, state: 'pending' | 'success' | 'failed', description: string): Promise<void>
  readMergeable(repo: string, pr: number): Promise<{ mergeable: boolean; conflictPassed: boolean }>
  /** 预留：PR 回复与线程 resolve 写入反馈。 */
  listReplies(repo: string, pr: number, since?: string): Promise<CommentSummary[]>
}

export interface PullSummary {
  number: number
  headSha: string
  baseSha: string
  author: string
  updatedAt: string
}

export interface PullDetail extends PullSummary {
  title: string
  description: string
}

export interface CommentSummary {
  id: string
  author: string
  body: string
  at: string
  /** 行内评论才有位置。 */
  location?: CodeLocation
}

/** 仓库访问。v1 用 git CLI 实现。 */
export interface VcsPort {
  diff(repoPath: string, base: string, head: string): Promise<DiffSummary>
  blame(repoPath: string, sha: string, path: string): Promise<BlameLine[]>
  readFileAt(repoPath: string, sha: string, path: string): Promise<string | undefined>
  makeWorktree(repoPath: string, sha: string, targetDir: string, readOnly: boolean): Promise<void>
  removeWorktree(targetDir: string): Promise<void>
  /** 预留：V2 的合并候选版本。 */
  buildCandidate(repoPath: string, base: string, prs: number[]): Promise<{ sha: string; conflicts: string[] }>
}

export interface DiffSummary {
  changedFiles: string[]
  changedLines: number
  hunks: Array<{ path: string; oldStart: number; newStart: number; lines: number }>
}

export interface BlameLine {
  line: number
  sha: string
  author: string
}

/** 一次 agent 调用的请求与结果。 */
export interface AgentRunnerRequest<T> {
  role: 'finder' | 'verifier'
  profile: string
  prompt: string
  cwd: string
  readOnlyTools: string[]
  submit: { name: string; schema: unknown; max: number }
  budget: { maxTurns: number; maxMs: number }
  /** 取消信号。置位后适配器应尽快停止并如实报告 ended。 */
  signal?: { readonly aborted: boolean }
}

export interface AgentRunnerResult<T> {
  sessionId: string
  items: T[]
  usage: { turns: number; durationMs: number; tokens?: number }
  ended: 'done' | 'budget' | 'error'
}

export interface AgentRunner {
  run<T>(request: AgentRunnerRequest<T>): Promise<AgentRunnerResult<T>>
}

/** 一条历史发现在本 PR 上的状态，供第 4 条不变量使用。 */
export type PriorFindingState = 'open' | 'false-positive' | 'intended' | 'unimportant' | 'resolved' | 'dismissed'

/**
 * 持久化端口。
 *
 * 唯一写入者是 Scheduler：界面、HTTP 接口、来源轮询都只向它发请求，
 * 由它写库并记事件。这条规定让"运行状态只有一个写入者"可被验证。
 */
export interface StorePort {
  insertRun(run: Run): Promise<void>
  getRun(runId: string): Promise<Run | undefined>
  /** 唯一键查询：同一 (仓库, PR, 评审类型, head) 只应有一条运行。 */
  findRunByHead(repo: string, pr: number, reviewKind: ReviewKind, headSha: string): Promise<Run | undefined>
  updateRun(run: Run): Promise<void>
  listRuns(filter?: { statuses?: RunStatus[]; limit?: number }): Promise<Run[]>
  /** 熔断用：该 PR 近 24 小时起了几次运行。 */
  runsInLast24h(repo: string, pr: number, now: number): Promise<number>

  recordStage(exec: StageExec): Promise<void>
  listStages(runId: string): Promise<StageExec[]>

  insertFinding(finding: Finding): Promise<void>
  updateFindingStatus(findingId: string, status: Finding['status']): Promise<void>
  listFindings(runId: string): Promise<Finding[]>
  /** 按指纹查本 PR 上该问题的历史状态。 */
  priorFindingState(repo: string, pr: number, fingerprint: string): Promise<PriorFindingState | undefined>

  insertVote(vote: Vote): Promise<void>
  listVotes(findingId: string): Promise<Vote[]>
  insertFeedback(feedback: Feedback): Promise<void>
  listFeedback(findingId: string): Promise<Feedback[]>

  appendEvent(event: Omit<RunEvent, 'seq'>): Promise<number>
  listEvents(runId: string, sinceSeq?: number): Promise<RunEvent[]>

  /**
   * 保存可恢复的中间态。
   *
   * 需要它的理由：从 plan 阶段恢复时，collect 产出的 diff 与规则快照已经不在内存里，
   * 若不持久化，plan 会认为"没有 diff"而停下。发现与投票已有独立表，因此这里只存
   * 那些无法从表里还原的字段。
   */
  saveProgress(runId: string, progress: string): Promise<void>
  loadProgress(runId: string): Promise<string | undefined>

  close(): Promise<void>
}

/** 通知。v1 不启用，预留 WeLink。 */
export interface Notifier {
  notify(message: { title: string; body: string; needsHuman: boolean }): Promise<void>
}

/** 预留：把风险分成档，v1 用路径规则加改动量，将来换模型分类器。 */
export interface RiskClassifier {
  classify(diff: DiffSummary): Promise<Depth>
}

/** 预留：合并治理只输出建议，不执行合并。 */
export interface MergeAdvisor {
  advise(input: { repo: string; pr: number; base: string; head: string }): Promise<{ ok: boolean; reasons: string[] }>
}

/** 指纹策略的再导出，便于 adapters 只依赖 ports。 */
export type { FingerprintInput }

/** 一个提交上来的原始发现，尚未经引擎补全身份。 */
export interface SubmittedFinding {
  title: string
  path: string
  line: number
  category: Category
  severity: Severity
  trigger: string
  outcome: string
  evidence?: CodeLocation[]
  introducedByChange: 'yes' | 'no' | 'unknown'
  confidence: 'high' | 'medium' | 'low'
  /** 产生它的 finder profile，由 find 阶段补入。 */
  finderProfile?: string
}

/** 一次核实意见。 */
export interface SubmittedVerdict {
  verdict: 'stands' | 'rejected' | 'uncertain'
  reproducesOnBase: 'yes' | 'no' | 'unknown'
  evidence?: string
}

export type { RunTarget, ReviewKind }
