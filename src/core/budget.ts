/**
 * 预算记账。评审系统被放弃的最常见原因不是质量，是成本失控，
 * 所以每个档位都要有会话数、token、时间三个硬上限。
 *
 * 有一处对任务书表格的修正，记录在此：
 *   任务书 Quick 档写的是"候选上限 6、核实会话 1、会话总上限 2"，
 *   而批量核实的规则是"每批最多 5 条"。6 条要 2 批，即 2 个核实会话，
 *   加上 1 个 finder 是 3 个会话，超过上限 2。
 *   本实现取"候选上限改为 5"，使 5 条正好一批，与 1 个核实会话自洽。
 */
import type { Depth, Usage } from './model.ts'

/** 一次运行的预算上限。 */
export interface BudgetLimits {
  finders: number
  candidateCap: number
  verifySessions: number
  extraVoteSessions: number
  sessionCap: number
  tokenCap: number
  timeCapMs: number
  /** 单个 finder 会话的回合上限与时长上限。 */
  finderTurns: number
  finderMs: number
  /** 单个 verifier 会话的回合上限与时长上限。 */
  verifierTurns: number
  verifierMs: number
  /** 批量核实每批的最大条数。 */
  verifyBatchSize: number
}

const WAN = 10_000

export const BUDGETS: Record<Depth, BudgetLimits> = {
  quick: {
    finders: 1,
    candidateCap: 5,
    verifySessions: 1,
    extraVoteSessions: 0,
    sessionCap: 2,
    tokenCap: 40 * WAN,
    timeCapMs: 10 * 60_000,
    finderTurns: 30,
    finderMs: 10 * 60_000,
    verifierTurns: 15,
    verifierMs: 5 * 60_000,
    verifyBatchSize: 5,
  },
  standard: {
    finders: 2,
    candidateCap: 10,
    verifySessions: 2,
    extraVoteSessions: 2,
    sessionCap: 6,
    tokenCap: 120 * WAN,
    timeCapMs: 25 * 60_000,
    finderTurns: 30,
    finderMs: 10 * 60_000,
    verifierTurns: 15,
    verifierMs: 5 * 60_000,
    verifyBatchSize: 5,
  },
  deep: {
    finders: 4,
    candidateCap: 16,
    verifySessions: 4,
    extraVoteSessions: 4,
    sessionCap: 12,
    tokenCap: 300 * WAN,
    timeCapMs: 45 * 60_000,
    finderTurns: 30,
    finderMs: 10 * 60_000,
    verifierTurns: 15,
    verifierMs: 5 * 60_000,
    verifyBatchSize: 5,
  },
}

/** 一次运行里已经用掉的部分。 */
export interface BudgetUsed {
  sessions: number
  /** 累计回合数，用于校准预算表。 */
  turns: number
  tokens: number
  elapsedMs: number
}

export const emptyUsed = (): BudgetUsed => ({ sessions: 0, turns: 0, tokens: 0, elapsedMs: 0 })

/** 核算一档要几个核实会话：按候选数与每批大小向上取整，再受档位上封顶。 */
export function verifySessionsNeeded(limits: BudgetLimits, candidates: number): number {
  const capped = Math.min(candidates, limits.candidateCap)
  const batches = Math.ceil(capped / limits.verifyBatchSize)
  return Math.min(batches, limits.verifySessions)
}

/** 还能不能起一个新会话。返回拒绝理由，或 undefined 表示可以。 */
export function mayStartSession(limits: BudgetLimits, used: BudgetUsed): string | undefined {
  if (used.sessions >= limits.sessionCap) {
    return `会话数已达上限 ${limits.sessionCap}`
  }
  if (used.elapsedMs >= limits.timeCapMs) {
    return `耗时已达上限 ${Math.round(limits.timeCapMs / 1000)} 秒`
  }
  return undefined
}

/** 预算是否已经耗尽，决定这次运行以 partial 收尾。 */
export function exhausted(limits: BudgetLimits, used: BudgetUsed): boolean {
  if (used.tokens >= limits.tokenCap) return true
  if (used.elapsedMs >= limits.timeCapMs) return true
  return false
}

/** 记账：把一个会话的用量累加进去。 */
export function charge(used: BudgetUsed, delta: Partial<Usage> & { tokens?: number }): BudgetUsed {
  return {
    sessions: used.sessions + (delta.sessions ?? 1),
    turns: used.turns + (delta.turns ?? 0),
    tokens: used.tokens + (delta.tokens ?? 0),
    elapsedMs: Math.max(used.elapsedMs, delta.durationMs ?? 0),
  }
}

/**
 * 预算耗尽时怎么收尾：没来得及核实的候选标 unverified，永不发布，
 * 运行状态记 partial。这条要显式写在函数里，避免实现时忘记。
 */
export interface OverflowOutcome {
  runStatus: 'partial'
  unverified: true
  publishable: false
}

export const overflowOutcome = (): OverflowOutcome => ({ runStatus: 'partial', unverified: true, publishable: false })

/** 超大 PR 的处置：不升档，按路径风险挑最重要的文件审，其余列为未评审。 */
export const OVERSIZE_LINES = 1500
export const OVERSIZE_FILES = 40

export function oversize(changedLines: number, changedFiles: number): boolean {
  return changedLines > OVERSIZE_LINES || changedFiles > OVERSIZE_FILES
}
