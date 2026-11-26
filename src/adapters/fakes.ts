/**
 * 假适配器。T2 的全部测试都在它们上面跑，不碰 DSH、不碰 GitCode、不联网。
 *
 * 设计原则：假件要能表达"计划中的坏事"，而不只是"计划中的好事"。
 * 所以它们可以被配置成预算耗尽、投票矛盾、读到了不该读的路径。
 *
 * 注意：构造函数用显式字段赋值，不用 TypeScript 的参数属性，
 * 因为 Node 的类型剥离（strip-only 模式）不支持参数属性。
 */
import type {
  AgentRunner, AgentRunnerRequest, AgentRunnerResult, BlameLine, CommentSummary,
  DiffSummary, ForgePort, PullDetail, PullSummary, SubmittedFinding, SubmittedVerdict,
  VcsPort,
} from '../core/ports.ts'

export interface VcsConfig {
  diff: DiffSummary
  /** key 是 `${sha}:${path}`。 */
  files?: Record<string, string>
}

/** 可编排的 VcsPort。 */
export class FakeVcs implements VcsPort {
  readonly diffCalls: Array<{ base: string; head: string }> = []
  readonly worktrees: Array<{ sha: string; targetDir: string; readOnly: boolean }> = []
  private readonly config: VcsConfig
  private readonly reads: Array<{ sha: string; path: string }> = []

  constructor(config: VcsConfig) {
    this.config = config
  }

  async diff(_repoPath: string, base: string, head: string): Promise<DiffSummary> {
    this.diffCalls.push({ base, head })
    return this.config.diff
  }

  async blame(): Promise<BlameLine[]> {
    return []
  }

  async readFileAt(_repoPath: string, sha: string, path: string): Promise<string | undefined> {
    this.reads.push({ sha, path })
    return this.config.files?.[`${sha}:${path}`]
  }

  async makeWorktree(_repoPath: string, sha: string, targetDir: string, readOnly: boolean): Promise<void> {
    this.worktrees.push({ sha, targetDir, readOnly })
  }

  async removeWorktree(): Promise<void> {}

  async buildCandidate(): Promise<{ sha: string; conflicts: string[] }> {
    return { sha: 'candidate-sha', conflicts: [] }
  }

  /** 断言用：规则文件应当从 base 读，不应从 head 读。 */
  ruleFileReads(): Array<{ sha: string; path: string }> {
    return this.reads.filter(read => read.path === 'AGENTS.md' || read.path === 'REVIEW.md')
  }
}

export interface ForgeConfig {
  pulls?: PullSummary[]
  details?: Record<number, PullDetail>
  comments?: CommentSummary[]
}

/** 可编排的 ForgePort。记录一切写操作，供断言"record 模式零写"。 */
export class FakeForge implements ForgePort {
  readonly writes: Array<{ kind: string; detail: unknown }> = []
  private readonly config: ForgeConfig

  constructor(config: ForgeConfig = {}) {
    this.config = config
  }

  async listPulls(): Promise<PullSummary[]> { return this.config.pulls ?? [] }
  async getPull(_repo: string, pr: number): Promise<PullDetail | undefined> { return this.config.details?.[pr] }
  async listComments(): Promise<CommentSummary[]> { return this.config.comments ?? [] }

  async postInline(_repo: string, _pr: number, finding: unknown): Promise<void> {
    this.writes.push({ kind: 'postInline', detail: finding })
  }

  async postSummary(_repo: string, _pr: number, body: string): Promise<void> {
    this.writes.push({ kind: 'postSummary', detail: body })
  }

  async setStatus(_repo: string, sha: string, state: string): Promise<void> {
    this.writes.push({ kind: 'setStatus', detail: { sha, state } })
  }

  async readMergeable(): Promise<{ mergeable: boolean; conflictPassed: boolean }> {
    return { mergeable: true, conflictPassed: true }
  }

  async listReplies(): Promise<CommentSummary[]> { return [] }
}

export interface AgentCall {
  role: 'finder' | 'verifier'
  profile: string
  sessionId: string
  itemCount: number
}

export interface AgentRunnerConfig {
  finders?: Record<string, SubmittedFinding[]>
  /** 决定每批怎么投票；不给则全部判成立且 base 上不复现。 */
  verify?: (request: AgentRunnerRequest<SubmittedVerdict>, batchIndex: number) => SubmittedVerdict[]
  /** 返回 true 表示这次调用以 budget 收尾。 */
  budgetOut?: (request: AgentRunnerRequest<unknown>) => boolean
  usage?: { turns: number; durationMs: number }
}

/** 可编排的 AgentRunner。 */
export class FakeAgentRunner implements AgentRunner {
  readonly calls: AgentCall[] = []
  private readonly config: AgentRunnerConfig
  private sessionSeq = 0

  constructor(config: AgentRunnerConfig = {}) {
    this.config = config
  }

  async run<T>(request: AgentRunnerRequest<T>): Promise<AgentRunnerResult<T>> {
    this.sessionSeq += 1
    const sessionId = `sess-${this.sessionSeq.toString().padStart(3, '0')}`
    this.calls.push({ role: request.role, profile: request.profile, sessionId, itemCount: 0 })
    // 取消信号一旦置位，如实报告 ended=error 且不产出任何条目。
    if (request.signal?.aborted) {
      return { sessionId, items: [] as unknown as T[], usage: { turns: 0, durationMs: 0 }, ended: 'error' }
    }
    const ended: AgentRunnerResult<T>['ended'] =
      this.config.budgetOut?.(request as unknown as AgentRunnerRequest<unknown>) ? 'budget' : 'done'
    const usage = this.config.usage ?? { turns: 5, durationMs: 1000 }
    const current = this.calls[this.calls.length - 1]

    if (request.role === 'finder') {
      const items = (this.config.finders?.[request.profile] ?? []) as unknown as T[]
      const capped = items.slice(0, request.submit.max)
      current.itemCount = capped.length
      return { sessionId, items: capped, usage, ended }
    }

    const batchIndex = this.calls.filter(call => call.role === 'verifier').length - 1
    const verdicts: SubmittedVerdict[] = this.config.verify
      ? this.config.verify(request as unknown as AgentRunnerRequest<SubmittedVerdict>, batchIndex)
      : Array.from({ length: request.submit.max }, () => ({ verdict: 'stands' as const, reproducesOnBase: 'no' as const }))
    current.itemCount = verdicts.length
    return { sessionId, items: verdicts as unknown as T[], usage, ended }
  }

  finderCalls(): AgentCall[] { return this.calls.filter(call => call.role === 'finder') }
  verifierCalls(): AgentCall[] { return this.calls.filter(call => call.role === 'verifier') }
}

/** 一份最小但真实的代码差异：两个文件，三个 hunk。 */
export function sampleDiff(overrides: Partial<DiffSummary> = {}): DiffSummary {
  return {
    changedFiles: ['src/a.ts', 'src/b.ts'],
    changedLines: 42,
    hunks: [
      { path: 'src/a.ts', oldStart: 10, newStart: 10, lines: 20 },
      { path: 'src/a.ts', oldStart: 60, newStart: 60, lines: 12 },
      { path: 'src/b.ts', oldStart: 5, newStart: 5, lines: 10 },
    ],
    ...overrides,
  }
}

/** 一条合法的提交发现。 */
export function sampleFinding(overrides: Partial<SubmittedFinding> = {}): SubmittedFinding {
  return {
    title: '空指针未判空',
    path: 'src/a.ts',
    line: 15,
    category: 'correctness',
    severity: 'important',
    trigger: '调用方传入 null 且未走默认分支',
    outcome: '在 a.ts:15 解引用时抛出 TypeError',
    introducedByChange: 'yes',
    confidence: 'high',
    ...overrides,
  }
}
