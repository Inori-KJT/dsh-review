/**
 * dsh-review 领域模型。
 *
 * 这一层是纯类型与纯谓词，不做 I/O、不 import 任何 @deepseek-ai 包，
 * 因此可以脱离 DSH 单测，也可以在将来的 CI 版里原样复用。
 */

/** 流水线的九个阶段，顺序由代码决定，模型只在阶段内部做判断。 */
export type StageId =
  | 'collect'
  | 'plan'
  | 'find'
  | 'dedupe'
  | 'verify'
  | 'classify'
  | 'filter'
  | 'gate'
  | 'publish'

/** 阶段的执行方式。deterministic 不调模型；agent 建会话；human 等人。 */
export type StageKind = 'deterministic' | 'agent' | 'human'

/** 一次运行的总体状态。needs_human 与 circuit_open 都必须区别于 failed。 */
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'partial'
  | 'needs_human'
  | 'circuit_open'
  | 'done'
  | 'failed'
  | 'cancelled'

/** 单个阶段每次尝试的状态。重跑就是新增一个 attempt，不覆盖旧的。 */
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/**
 * 一条发现的状态。
 *
 * candidate  finder 刚提交
 * verified   核实通过，可进入发布
 * rejected   核实判为不成立
 * unverified 预算耗尽没来得及核实，永不发布，只在面板可见
 * held       被扣下等人（安全类 Important、规则文件被改动、脱敏命中）
 * published  已发出（或只记录模式下已进入发布列表）
 * resolved   已修复或已关闭
 * stale      新一轮推送后它所在的行被改动
 * dismissed  人工判为不重要
 */
export type FindingStatus =
  | 'candidate'
  | 'verified'
  | 'rejected'
  | 'unverified'
  | 'held'
  | 'published'
  | 'resolved'
  | 'stale'
  | 'dismissed'

/** 严重度。Pre-existing 不由 finder 决定，由 classify 判定。 */
export type Severity = 'important' | 'nit' | 'pre-existing'

/** 发现的类别。review-config-change 专用于"PR 改了规则文件"。 */
export type Category = 'correctness' | 'security' | 'conventions' | 'intent' | 'review-config-change'

/** 评审类型。integration 预留给合并候选版本的多 MR 审查。 */
export type ReviewKind = 'bug' | 'security' | 'integration'

/** 深度档位。MVP 只实现 quick 与 standard，deep 只留配置。 */
export type Depth = 'quick' | 'standard' | 'deep'

/** 处置结论，四个按钮。 */
export type Verdict = 'valid' | 'false-positive' | 'intended' | 'unimportant'

/** 操作者身份。unknown 是默认值：不在名单里的账号一律不按人算。 */
export type ActorType = 'human' | 'developer_agent' | 'review_agent' | 'system' | 'unknown'

/** 发布模式。record 只写库不发出；comment 发评论；block 发评论并写 status。 */
export type PublishMode = 'record' | 'comment' | 'block'

/** 一次运行的目标。candidate 预留给合并候选版本。 */
export type RunTarget =
  | { kind: 'pr'; repo: string; pr: number }
  | { kind: 'candidate'; repo: string; base: string; prs: number[] }

/** 代码位置。引擎自己从 worktree 取原文，不接受 agent 贴的代码。 */
export interface CodeLocation {
  path: string
  startLine: number
  endLine: number
}

/** 发现的数据库主键与跨轮次身份是两件事，分成三个字段。 */
export interface Finding {
  /** 库内唯一主键。 */
  id: string
  /** 判断跨轮次是不是同一个问题；随 fingerprintVersion 一起解释。 */
  fingerprint: string
  fingerprintVersion: number
  /** 它属于哪个代码版本。 */
  headSha: string
  runId: string
  reviewKind: ReviewKind
  category: Category
  severity: Severity
  title: string
  /** 问题表现的位置（代码在哪一行表现出错误）。 */
  defectLocation: CodeLocation
  /** 触发条件，必填。空则引擎丢弃。 */
  trigger: string
  /** 错误结果，必填。空则引擎丢弃。 */
  outcome: string
  /** 与本次变更有因果关系的证据，只收位置引用。 */
  causalEvidence: CodeLocation[]
  /** 该问题是否由本次改动引入；unknown 按"引入"处理。 */
  introducedByChange: 'yes' | 'no' | 'unknown'
  /** 产生它的 finder profile 名。 */
  finderProfile: string
  /** 产生它的会话 id，便于回看对话轨迹。 */
  finderSessionId?: string
  status: FindingStatus
  /** 已解决后又被重新发现时，指向旧发现。 */
  reopenedFrom?: string
  createdAt: string
  updatedAt: string
}

/** 一条核实意见，每个 verifier 会话一行。 */
export interface Vote {
  findingId: string
  verifierSessionId: string
  verdict: 'stands' | 'rejected' | 'uncertain'
  /** 问题在 base 版本上是否同样成立。必填。 */
  reproducesOnBase: 'yes' | 'no' | 'unknown'
  evidence?: string
  at: string
}

/** 一次人工或渠道反馈。 */
export interface Feedback {
  findingId: string
  source: 'panel' | 'pr_reply' | 'thread_resolved'
  verdict: Verdict
  note?: string
  by: string
  actorType: ActorType
  at: string
}

/** 一次运行的用量记账，用于校准预算表。 */
export interface Usage {
  sessions: number
  turns: number
  durationMs: number
}

/** 一次运行。唯一键是 (repo, pr, reviewKind, headSha)。 */
export interface Run {
  id: string
  target: RunTarget
  repo: string
  /** 本地仓库路径，恢复运行时需要它重建 VcsPort 的工作目录。 */
  repoPath: string
  pr: number
  baseSha: string
  headSha: string
  /** 增量重审时只看 since..head；首次评审为空。 */
  since?: string
  reviewKind: ReviewKind
  depth: Depth
  mode: PublishMode
  round: number
  status: RunStatus
  /** 当前阶段，重启后从这里继续。 */
  cursor: StageId
  configRevision: number
  trigger: 'poll' | 'manual' | 'cli' | 'self-review'
  usage: Usage
  createdAt: string
  updatedAt: string
}

/** 一个阶段的一次尝试。 */
export interface StageExec {
  runId: string
  stage: StageId
  attempt: number
  status: StageStatus
  startedAt?: string
  endedAt?: string
  sessionIds: string[]
  usage: Usage
  error?: string
}

/** 追加式事件流，面板进度与审计都读它。 */
export interface RunEvent {
  seq: number
  runId: string
  at: string
  type: string
  payload: Record<string, unknown>
}

/** 八个防循环不变量。sleepMs 表示"允许"，reason 表示"拒绝并附理由"。 */
export interface InvariantVerdict {
  allowed: boolean
  code?: string
  reason?: string
}

export const allow = (): InvariantVerdict => ({ allowed: true })
export const deny = (code: string, reason: string): InvariantVerdict => ({ allowed: false, code, reason })

/** 运行是否已经停在终态，终态不再接受新的推进请求。 */
export const isTerminal = (status: RunStatus): boolean =>
  ['done', 'failed', 'cancelled', 'partial', 'needs_human', 'circuit_open'].includes(status)

/** 发现是否已经不该再出现在任何输出里。 */
export const isSuppressed = (finding: Pick<Finding, 'status'>): boolean =>
  ['rejected', 'dismissed', 'resolved', 'stale'].includes(finding.status)

/** 发现的身份是否可信：三个字段必须齐全。 */
export const hasIdentity = (finding: Pick<Finding, 'id' | 'fingerprint' | 'headSha' | 'fingerprintVersion'>): boolean =>
  finding.id.length > 0 && finding.fingerprint.length > 0 && finding.headSha.length > 0 && finding.fingerprintVersion >= 1
