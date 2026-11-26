/**
 * 确定性阶段：collect、plan、dedupe、classify、filter。
 *
 * 这些阶段不调模型，因此可以完全确定地单测。它们的共同职责是把"模型产出的
 * 一群自由发现"压缩成"一批身份明确、严重度已定、可以送人处置的发现"。
 */
import type { PipelineState, RuleSnapshot, StageFn } from '../core/run.ts'
import { allowedSeverities } from '../core/run.ts'
import { currentFingerprint, normalizeCode } from '../core/fingerprint.ts'
import { oversize } from '../core/budget.ts'
import { invariantFingerprintLifecycle, severitiesForRound } from '../core/invariants.ts'
import { sanitizeFinding } from '../core/sanitize.ts'
import type { Category, Finding, Severity } from '../core/model.ts'

const RULE_FILES = ['AGENTS.md', 'REVIEW.md']
const RULE_DIR_PREFIX = '.dsh-review/'

/** 从 base 版本读规则文件。规则只信 base，因为 PR 可以顺手改掉规则把自己放过去。 */
export const collect: StageFn = async (state, deps) => {
  const { repoPath } = state
  const { baseSha, headSha, since } = state.run
  state.diff = await deps.vcs.diff(repoPath, since ?? baseSha, headSha)

  const snapshot: RuleSnapshot = { present: [] }
  for (const name of RULE_FILES) {
    const text = await deps.vcs.readFileAt(repoPath, baseSha, name)
    if (text === undefined) continue
    snapshot.present.push(name)
    if (name === 'AGENTS.md') snapshot.agentsMd = text
    if (name === 'REVIEW.md') snapshot.reviewMd = text
  }
  state.baseRules = snapshot

  state.ruleFilesTouched = state.diff.changedFiles.filter(
    path => RULE_FILES.includes(path) || path.startsWith(RULE_DIR_PREFIX),
  )
  if (state.ruleFilesTouched.length > 0) {
    // PR 改评审规则这件事本身就要人看，因此直接生成一条 held 发现。
    const touched = state.ruleFilesTouched[0]
    state.findings.push(makeFinding(state, {
      category: 'review-config-change',
      severity: 'important',
      title: `本次改动修改了评审规则文件 ${state.ruleFilesTouched.join(', ')}`,
      path: touched,
      line: 1,
      trigger: '合并请求改动了规则文件',
      outcome: '评审规则被改动，引擎按 base 版本的规则运行，需人工确认改动意图',
      introducedByChange: 'yes',
      finderProfile: 'engine',
      status: 'held',
    }))
  }
  return undefined
}

/** 定风险与深度。MVP 只处理超大 PR：不升档，挑最重要的文件审，其余标注未评审。 */
export const plan: StageFn = async (state, _deps, preset) => {
  const diff = state.diff
  if (!diff) return 'collect 没有产出 diff'
  state.oversized = oversize(diff.changedLines, diff.changedFiles.length)
  if (!state.oversized) {
    state.selectedPaths = [...diff.changedFiles]
    return undefined
  }
  const weight = new Map<string, number>()
  for (const hunk of diff.hunks) weight.set(hunk.path, (weight.get(hunk.path) ?? 0) + hunk.lines)
  const ordered = [...diff.changedFiles].sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0))
  state.selectedPaths = ordered.slice(0, preset.limits.candidateCap * 3)
  state.skippedPaths = ordered.slice(state.selectedPaths.length)
  state.notes.push(`超大 PR：${diff.changedFiles.length} 个文件 ${diff.changedLines} 行，只审前 ${state.selectedPaths.length} 个，其余 ${state.skippedPaths.length} 个列为未评审`)
  return undefined
}

/**
 * 去重与身份分配。
 *
 * 三件事：给每条发现算出指纹；丢掉不该再出现的（未解决的同一指纹、已判误报或有意为之的）；
 * 丢掉本批内部重复的，并按同路径同代码的出现次序分配序号，使两处相同片段不被合并。
 */
export const dedupe: StageFn = async (state) => {
  const seenAtLocation = new Set<string>()
  const codeCount = new Map<string, number>()
  const kept: Finding[] = []

  for (const submitted of state.submitted) {
    // 第一层：位置与类别都相同，视为同一条发现被报了两次，直接合并。
    const locationKey = `${submitted.path}|${submitted.line}|${submitted.category}`
    if (seenAtLocation.has(locationKey)) continue
    seenAtLocation.add(locationKey)

    // 第二层：同一文件里相同结论出现在不同位置时，靠序号区分成两个问题。
    const code = normalizeCode(submitted.outcome)
    const seed = `${submitted.path}\u0000${code}`
    const ordinal = (codeCount.get(seed) ?? 0) + 1
    codeCount.set(seed, ordinal)
    const fingerprint = currentFingerprint.of({
      path: submitted.path,
      symbol: '',
      category: submitted.category,
      code,
      ordinal,
    })

    if (state.priorFindings.has(fingerprint)) {
      const verdict = invariantFingerprintLifecycle(state.priorFindings.get(fingerprint))
      if (!verdict.allowed) continue
    }
    if (state.findings.some(finding => finding.fingerprint === fingerprint)) continue
    if (kept.some(finding => finding.fingerprint === fingerprint)) continue

    const sanitized = sanitizeFinding({
      title: submitted.title,
      trigger: submitted.trigger,
      outcome: submitted.outcome,
      evidence: submitted.evidence?.map(item => `${item.path}:${item.startLine}`).join(' '),
    })

    kept.push(makeFinding(state, {
      category: submitted.category,
      severity: submitted.severity,
      title: sanitized.redacted.title,
      path: submitted.path,
      line: submitted.line,
      trigger: sanitized.redacted.trigger,
      outcome: sanitized.redacted.outcome,
      introducedByChange: submitted.introducedByChange,
      finderProfile: submitted.finderProfile ?? 'unknown',
      fingerprint,
      status: sanitized.held ? 'held' : 'candidate',
      evidence: submitted.evidence,
    }))
  }

  state.findings = [...state.findings, ...kept]
  return undefined
}

/**
 * 判断问题是否由本次改动引入。
 *
 * 只有三个条件同时成立才标 pre-existing，其余（含任何一个是 unknown）都按本 PR 引入处理。
 * 宁可多拦也不漏放，因为把真问题当成旧账的代价比误报高。
 */
export const classify: StageFn = async (state) => {
  const diff = state.diff
  const roundSeverities = severitiesForRound(state.run.round)
  for (const finding of state.findings) {
    if (finding.category === 'review-config-change') continue
    const inDiff = diff ? diff.hunks.some(hunk =>
      hunk.path === finding.defectLocation.path &&
      finding.defectLocation.startLine >= hunk.newStart - 3 &&
      finding.defectLocation.startLine <= hunk.newStart + hunk.lines + 3,
    ) : false
    const votesFor = state.votes.filter(vote => vote.findingId === finding.id)
    const reproducesOnBase = votesFor.some(vote => vote.reproducesOnBase === 'yes')
    const anyoneSaysNo = votesFor.some(vote => vote.reproducesOnBase === 'no')

    const qualified = !inDiff && finding.introducedByChange === 'no' && reproducesOnBase && !anyoneSaysNo
    finding.severity = qualified ? 'pre-existing' : (finding.severity === 'pre-existing' ? 'important' : finding.severity)

    if (!roundSeverities.includes(finding.severity === 'pre-existing' ? 'nit' : finding.severity)) {
      finding.status = 'dismissed'
    }
  }
  return undefined
}

/** 过滤：跳过未评审的路径，压掉纯风格类，限制 nit 数量。 */
export const NIT_CAP = 3

export const filter: StageFn = async (state) => {
  const skipped = new Set(state.skippedPaths)
  let nits = 0
  for (const finding of state.findings) {
    if (finding.status === 'held' || finding.status === 'dismissed') continue
    if (skipped.has(finding.defectLocation.path)) {
      finding.status = 'dismissed'
      continue
    }
    if (finding.severity === 'nit') {
      nits += 1
      if (nits > NIT_CAP) finding.status = 'dismissed'
      continue
    }
    // 没有触发条件或错误结果的发现直接丢弃：那类发现不可操作。
    if (!finding.trigger.trim() || !finding.outcome.trim()) finding.status = 'dismissed'
  }
  return undefined
}

let counter = 0

function makeFinding(state: PipelineState, input: {
  category: Category
  severity: Severity
  title: string
  path: string
  line: number
  trigger: string
  outcome: string
  introducedByChange: 'yes' | 'no' | 'unknown'
  finderProfile: string
  fingerprint?: string
  status?: Finding['status']
  evidence?: Array<{ path: string; startLine: number; endLine: number }>
}): Finding {
  counter += 1
  const at = new Date(state.startedAt + counter).toISOString()
  return {
    id: `f-${counter.toString().padStart(4, '0')}`,
    fingerprint: input.fingerprint ?? `pending-${counter}`,
    fingerprintVersion: currentFingerprint.version,
    headSha: state.run.headSha,
    runId: state.run.id,
    reviewKind: state.run.reviewKind,
    category: input.category,
    severity: input.severity,
    title: input.title,
    defectLocation: { path: input.path, startLine: input.line, endLine: input.line },
    trigger: input.trigger,
    outcome: input.outcome,
    causalEvidence: input.evidence ?? [],
    introducedByChange: input.introducedByChange,
    finderProfile: input.finderProfile,
    status: input.status ?? 'candidate',
    createdAt: at,
    updatedAt: at,
  }
}

export { makeFinding, allowedSeverities }
