/**
 * 评测集与基线。
 *
 * 四个指标，各有明确用途与局限：
 *   已知缺陷命中率  在缺陷集上，引擎的发现覆盖到已知缺陷位置的比例。相对指标，用于比较两版配置。
 *   干净集误报数    在干净集上每个 PR 平均报出的 Important 条数。度量会导致有害修改的噪声。
 *   处置比例        线上主指标，来自面板的四个按钮。这里是留位，评测阶段用不到。
 *   成本            每次运行的会话数、回合数、耗时。用于校准预算表。
 *
 * 缺陷集不靠人工凭空标注，而是从仓库历史反推：被 revert 的提交，以及提交信息里写明
 * "修复某提交引入的问题"的提交。人只做一件事——确认"这个修复确实修的是那个提交引入的问题"。
 */
import type { Finding } from '../core/model.ts'

/* ---------- 用例 ---------- */

export type CaseSource = 'revert' | 'fix' | 'injected' | 'clean'

export interface EvalCase {
  id: string
  source: CaseSource
  /** 引入缺陷的那个提交，作为评审的 head。 */
  headSha: string
  /** 它的父提交，作为 base。 */
  baseSha: string
  /** 缺陷位置提示；可以只有文件没有行号。 */
  hints: Array<{ path: string; line?: number }>
  /** 出处：由哪个提交反推出来的。 */
  evidence: string
  /** 需要人工确认的一句话。 */
  needsConfirmation: string
}

/** 一条 git 提交的精简视图，挖掘脚本与测试都用它。 */
export interface CommitView {
  sha: string
  parents: string[]
  subject: string
  body: string
  at: string
  /** 该提交改动的文件与行（新增侧）。 */
  changes: Array<{ path: string; newStart: number; lines: number }>
}

const REVERT_SUBJECT = /^revert\b/i
const REVERT_BODY = /This reverts commit ([0-9a-f]{7,40})/i
const FIX_SUBJECT = /^(fix|修复|hotfix)\b/i
const INTRODUCED_BY = /(?:introduced by|由\s*([0-9a-f]{7,40})|修复\s*([0-9a-f]{7,40}))[^\n]*/i
const SHA = /\b([0-9a-f]{7,40})\b/

/**
 * 从提交历史里挖候选用例。两类来源：
 *   1 revert 提交：被 revert 的那个提交就是引入缺陷的提交。
 *   2 修复提交：提交信息里点名了引入它的提交。
 *
 * 没有点名的修复提交不采信，因为"这次修的是哪个提交引入的问题"无法从文本可靠确定，
 * 猜错会让缺陷集写成假的。
 */
export function mineCases(commits: readonly CommitView[]): EvalCase[] {
  const bySha = new Map(commits.map(commit => [commit.sha, commit]))
  const cases: EvalCase[] = []

  for (const commit of commits) {
    // 1 revert
    if (REVERT_SUBJECT.test(commit.subject) || REVERT_BODY.test(commit.body)) {
      const matched = REVERT_BODY.exec(commit.body) ?? REVERT_BODY.exec(commit.subject)
      const target = matched?.[1] ?? findShaInText(commit.subject + ' ' + commit.body, bySha)
      const reverted = target ? bySha.get(resolvePrefix(bySha, target) ?? target) : undefined
      if (!reverted) continue
      cases.push({
        id: `revert-${commit.sha.slice(0, 8)}`,
        source: 'revert',
        headSha: reverted.sha,
        baseSha: reverted.parents[0] ?? '',
        hints: reverted.changes.map(change => ({ path: change.path, line: change.newStart })),
        evidence: `revert ${commit.sha.slice(0, 8)} 撤销了 ${reverted.sha.slice(0, 8)}`,
        needsConfirmation: `确认 ${commit.sha.slice(0, 8)} 撤销的是 ${reverted.sha.slice(0, 8)} 引入的缺陷，而不是功能回退`,
      })
      continue
    }

    // 2 修复提交，且点名了引入者
    if (!FIX_SUBJECT.test(commit.subject) && !/修复/.test(commit.subject)) continue
    const mention = INTRODUCED_BY.exec(commit.subject + '\n' + commit.body)
    const target = mention?.[1] ?? mention?.[2] ?? findShaInText(commit.subject + ' ' + commit.body, bySha, commit.sha)
    const introduced = target ? bySha.get(resolvePrefix(bySha, target) ?? target) : undefined
    if (!introduced || introduced.sha === commit.sha) continue
    cases.push({
      id: `fix-${commit.sha.slice(0, 8)}`,
      source: 'fix',
      headSha: introduced.sha,
      baseSha: introduced.parents[0] ?? '',
      hints: commit.changes.map(change => ({ path: change.path, line: change.newStart })),
      evidence: `修复提交 ${commit.sha.slice(0, 8)} 点名了 ${introduced.sha.slice(0, 8)}`,
      needsConfirmation: `确认 ${commit.sha.slice(0, 8)} 修的是 ${introduced.sha.slice(0, 8)} 引入的问题，而不是顺带改动`,
    })
  }
  return dedupe(cases)
}

/**
 * 干净集：合并超过 60 天、没被 revert、改动的文件之后没被修复提交碰过。
 *
 * 明确的局限：这里是文件级判断，不是行级。行级判断会把大 PR 系统性筛掉，
 * 因为改动越多越可能被后来任何一个修复提交碰到；文件级宽松一些，代价是干净集里
 * 可能混进真正的缺陷。报告里要标明这一点。
 */
export function mineCleanCases(
  commits: readonly CommitView[],
  options: { now: number; olderThanDays?: number; limit?: number },
): EvalCase[] {
  const olderThanDays = options.olderThanDays ?? 60
  const cutoff = options.now - olderThanDays * 86_400_000
  const reverted = new Set<string>()
  const fixTouchedPaths = new Set<string>()

  for (const commit of commits) {
    if (REVERT_SUBJECT.test(commit.subject) || REVERT_BODY.test(commit.body)) {
      const matched = REVERT_BODY.exec(commit.body) ?? REVERT_BODY.exec(commit.subject)
      const target = matched?.[1]
      if (target) reverted.add(target)
    }
    if (FIX_SUBJECT.test(commit.subject) || /修复/.test(commit.subject)) {
      for (const change of commit.changes) fixTouchedPaths.add(change.path)
    }
  }

  const clean: EvalCase[] = []
  for (const commit of commits) {
    if (Date.parse(commit.at) > cutoff) continue
    if (reverted.has(commit.sha)) continue
    if (commit.changes.length === 0) continue
    if (commit.changes.some(change => fixTouchedPaths.has(change.path))) continue
    clean.push({
      id: `clean-${commit.sha.slice(0, 8)}`,
      source: 'clean',
      headSha: commit.sha,
      baseSha: commit.parents[0] ?? '',
      hints: [],
      evidence: `${commit.at.slice(0, 10)} 的提交，未被 revert，其文件未被修复提交碰过`,
      needsConfirmation: '确认这个提交确实没有已知缺陷',
    })
    if (clean.length >= (options.limit ?? 20)) break
  }
  return clean
}

function findShaInText(text: string, bySha: Map<string, CommitView>, exclude?: string): string | undefined {
  for (const match of text.matchAll(new RegExp(SHA, 'g'))) {
    const candidate = resolvePrefix(bySha, match[1])
    if (candidate && candidate !== exclude) return candidate
  }
  return undefined
}

function resolvePrefix(bySha: Map<string, CommitView>, prefix: string): string | undefined {
  if (bySha.has(prefix)) return prefix
  for (const sha of bySha.keys()) if (sha.startsWith(prefix)) return sha
  return undefined
}

function dedupe(cases: EvalCase[]): EvalCase[] {
  const seen = new Set<string>()
  return cases.filter(item => {
    if (seen.has(item.headSha)) return false
    seen.add(item.headSha)
    return true
  })
}

/* ---------- 指标 ---------- */

/** 命中判定：同文件且相距十行以内。 */
export const HIT_WINDOW = 10

export function isHit(finding: Finding, hints: readonly { path: string; line?: number }[]): boolean {
  for (const hint of hints) {
    if (finding.defectLocation.path !== hint.path) continue
    if (hint.line === undefined) return true
    if (Math.abs(finding.defectLocation.startLine - hint.line) <= HIT_WINDOW) return true
  }
  return false
}

export interface CaseResult {
  caseId: string
  source: CaseSource
  runId: string
  status: string
  findingCount: number
  importantCount: number
  /** 缺陷集才有：命中的 hint 个数。 */
  hits: number
  hintCount: number
  sessions: number
  turns: number
  durationMs: number
}

export interface EvalSummary {
  caseCount: number
  /** 已知缺陷命中率：命中的 hint 数 / hint 总数。 */
  hitRate: number
  /** 干净集误报数：每个 PR 平均 Important 条数。 */
  falsePositivePerPr: number
  /** 平均轮次。评测集里每个用例只跑一轮，因此恒为 1。 */
  averageRounds: number
  cost: { sessions: number; turns: number; durationMs: number }
  bySource: Record<string, { cases: number; hits: number; hints: number; important: number }>
}

export function summarize(results: readonly CaseResult[]): EvalSummary {
  const defects = results.filter(result => result.source !== 'clean')
  const clean = results.filter(result => result.source === 'clean')
  const hits = defects.reduce((sum, result) => sum + result.hits, 0)
  const hints = defects.reduce((sum, result) => sum + result.hintCount, 0)
  const cleanImportant = clean.reduce((sum, result) => sum + result.importantCount, 0)

  const bySource: EvalSummary['bySource'] = {}
  for (const result of results) {
    const bucket = bySource[result.source] ?? { cases: 0, hits: 0, hints: 0, important: 0 }
    bucket.cases += 1
    bucket.hits += result.hits
    bucket.hints += result.hintCount
    bucket.important += result.importantCount
    bySource[result.source] = bucket
  }

  return {
    caseCount: results.length,
    hitRate: hints === 0 ? 0 : hits / hints,
    falsePositivePerPr: clean.length === 0 ? 0 : cleanImportant / clean.length,
    averageRounds: results.length === 0 ? 0 : 1,
    cost: {
      sessions: results.reduce((sum, result) => sum + result.sessions, 0),
      turns: results.reduce((sum, result) => sum + result.turns, 0),
      durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    },
    bySource,
  }
}

/* ---------- 报告 ---------- */

export function renderEvalReport(input: {
  cases: readonly EvalCase[]
  results: readonly CaseResult[]
  summary: EvalSummary
  configRevision: number
  at: string
}): string {
  const { summary } = input
  const percent = (value: number) => `${(value * 100).toFixed(0)}%`
  const lines = [
    `# dsh-review 评测基线`,
    '',
    `生成时间 ${input.at} · 配置版本 ${input.configRevision} · 用例 ${summary.caseCount} 个`,
    '',
    '## 四个指标',
    '',
    '| 指标 | 值 | 局限 |',
    '| --- | --- | --- |',
    `| 已知缺陷命中率 | ${percent(summary.hitRate)} | 相对指标；只代表"后来出事"那类问题 |`,
    `| 干净集误报数 | 每个 PR ${summary.falsePositivePerPr.toFixed(2)} 条 Important | 干净只是"没发现出事"，不保证真的无 bug |`,
    `| 平均轮次 | ${summary.averageRounds} | 评测集每个用例只跑一轮 |`,
    `| 成本 | ${summary.cost.sessions} 会话 / ${summary.cost.turns} 回合 / ${Math.round(summary.cost.durationMs / 1000)} 秒 | 无 token 数，因为宿主取不到 |`,
    '',
    '## 分来源',
    '',
    '| 来源 | 用例 | 命中 | 提示数 | Important |',
    '| --- | --- | --- | --- | --- |',
    ...Object.entries(summary.bySource).map(([source, bucket]) =>
      `| ${source} | ${bucket.cases} | ${bucket.hits} | ${bucket.hints} | ${bucket.important} |`),
    '',
    '## 逐用例',
    '',
    '| 用例 | 来源 | 状态 | 发现 | Important | 命中/提示 | 会话 | 回合 | 耗时 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...input.results.map(result =>
      `| ${result.caseId} | ${result.source} | ${result.status} | ${result.findingCount} | ${result.importantCount} | ${result.hits}/${result.hintCount} | ${result.sessions} | ${result.turns} | ${Math.round(result.durationMs / 1000)}s |`),
    '',
    '## 需要人工确认的用例',
    '',
    ...input.cases.filter(item => item.source !== 'clean').map(item =>
      `- \`${item.id}\`：${item.needsConfirmation}`),
    '',
  ]
  return lines.join('\n')
}
