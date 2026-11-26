/**
 * 代理阶段：find 与 verify。这两个是唯一会起会话的阶段。
 *
 * 成本控制的三条手段都在这里：先压数量（每个 finder 交的条数有上限，全局再截断），
 * 批量核实（一个会话核实一批，按文件就近分组），自适应投票（第一轮每条一票，
 * 只有重要且被判成立的才加票）。
 */
import type { PipelineState, StageFn } from '../core/run.ts'
import { verifySessionsNeeded, mayStartSession, charge } from '../core/budget.ts'
import type { SubmittedFinding, SubmittedVerdict } from '../core/ports.ts'
import type { Finding, Vote } from '../core/model.ts'

const FINDER_SUBMIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'path', 'line', 'category', 'severity', 'trigger', 'outcome', 'introducedByChange'],
  properties: {
    title: { type: 'string', maxLength: 120 },
    path: { type: 'string' },
    line: { type: 'integer', minimum: 1 },
    category: { type: 'string', enum: ['correctness', 'security'] },
    severity: { type: 'string', enum: ['important', 'nit'] },
    trigger: { type: 'string' },
    outcome: { type: 'string' },
    introducedByChange: { type: 'string', enum: ['yes', 'no', 'unknown'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
}

const VERIFIER_SUBMIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'reproducesOnBase'],
  properties: {
    verdict: { type: 'string', enum: ['stands', 'rejected', 'uncertain'] },
    reproducesOnBase: { type: 'string', enum: ['yes', 'no', 'unknown'] },
    evidence: { type: 'string' },
  },
}

/** 每个 finder 单次最多交几条。全局还会再截断到档位上限。 */
export const FINDER_MAX_ITEMS = 6

export const find: StageFn = async (state, deps, preset) => {
  const profiles = preset.finderProfiles.slice(0, preset.limits.finders)
  const collected: SubmittedFinding[] = []

  for (const profile of profiles) {
    if (state.used.sessions >= preset.limits.sessionCap) {
      state.overflow = true
      state.notes.push(`find：起第 ${state.used.sessions + 1} 个会话前预算耗尽，跳过 ${profile}`)
      break
    }
    const reason = mayStartSession(preset.limits, state.used)
    if (reason) {
      state.overflow = true
      state.notes.push(`find：${reason}，跳过 ${profile}`)
      break
    }
    const result = await deps.agents.run<SubmittedFinding>({
      role: 'finder',
      profile,
      prompt: `以 ${profile} 视角评审本次改动。只为能说出触发条件与错误结果的问题提交发现。`,
      cwd: state.repoPath,
      readOnlyTools: ['read_file', 'glob', 'grep', 'working_directory'],
      submit: { name: 'submit_finding', schema: FINDER_SUBMIT_SCHEMA, max: FINDER_MAX_ITEMS },
      budget: { maxTurns: preset.limits.finderTurns, maxMs: preset.limits.finderMs },
      signal: deps.signal,
    })
    state.used = charge(state.used, { ...result.usage, sessions: 1 })
    for (const item of result.items.slice(0, FINDER_MAX_ITEMS)) {
      collected.push({ ...item, finderProfile: profile })
    }
    if (result.ended === 'budget') {
      state.overflow = true
      state.notes.push(`find：${profile} 会话超出自身预算，已收下已提交部分`)
    }
  }

  // 全局截断：按严重度优先，再按 confidence。
  const rank = (item: SubmittedFinding) =>
    (item.severity === 'important' ? 0 : 1) * 10 + ({ high: 0, medium: 1, low: 2 } as const)[item.confidence ?? 'low']
  state.submitted = collected.sort((a, b) => rank(a) - rank(b)).slice(0, preset.limits.candidateCap)
  return undefined
}

export const verify: StageFn = async (state, deps, preset) => {
  if (!preset.verify) return undefined
  const pending = state.findings.filter(finding => finding.status === 'candidate')
  if (pending.length === 0) return undefined

  // 按文件就近分组，每批最多 verifyBatchSize 条。
  const byPath = new Map<string, Finding[]>()
  for (const finding of pending) {
    const list = byPath.get(finding.defectLocation.path) ?? []
    list.push(finding)
    byPath.set(finding.defectLocation.path, list)
  }
  const batches: Finding[][] = []
  for (const list of byPath.values()) {
    for (let index = 0; index < list.length; index += preset.limits.verifyBatchSize) {
      batches.push(list.slice(index, index + preset.limits.verifyBatchSize))
    }
  }
  const sessionBudget = verifySessionsNeeded(preset.limits, pending.length)

  let spent = 0
  for (const batch of batches) {
    if (spent >= sessionBudget) {
      for (const finding of batch) finding.status = 'unverified'
      continue
    }
    const reason = mayStartSession(preset.limits, state.used)
    if (reason) {
      state.overflow = true
      for (const finding of batch) finding.status = 'unverified'
      state.notes.push(`verify：${reason}，${batch.length} 条标 unverified`)
      break
    }
    const result = await deps.agents.run<SubmittedVerdict>({
      role: 'verifier',
      profile: 'verifier',
      prompt: `核实下列发现，默认怀疑，举证责任在发现一方：\n${batch.map(f => `- ${f.id} ${f.title} @ ${f.defectLocation.path}:${f.defectLocation.startLine}`).join('\n')}`,
      cwd: state.repoPath,
      readOnlyTools: ['read_file', 'glob', 'grep', 'working_directory'],
      submit: { name: 'submit_verdict', schema: VERIFIER_SUBMIT_SCHEMA, max: batch.length },
      budget: { maxTurns: preset.limits.verifierTurns, maxMs: preset.limits.verifierMs },
      signal: deps.signal,
    })
    state.used = charge(state.used, { ...result.usage, sessions: 1 })
    spent += 1
    result.items.slice(0, batch.length).forEach((verdict, index) => {
      const finding = batch[index]
      if (!finding) return
      state.votes.push({
        findingId: finding.id,
        verifierSessionId: result.sessionId,
        verdict: verdict.verdict,
        reproducesOnBase: verdict.reproducesOnBase,
        evidence: verdict.evidence,
        at: new Date().toISOString(),
      })
    })
    if (result.ended === 'budget') {
      state.overflow = true
      state.notes.push(`verify：批次 ${batch[0]?.id ?? ''} 超出会话预算`)
    }
  }

  applyVerdicts(state)

  // 自适应加票：第一轮只有一票。只有"重要且已被判成立、且没人说不成立"的才加第二票；
  // Nit 不加票。这就是"Important 需两票"能成立、又不必每条都花两票的原因。
  let extraSpent = 0
  const needsSecond = () => state.findings.filter(finding => {
    if (finding.status !== 'verified' || finding.severity !== 'important') return false
    const votes = state.votes.filter(vote => vote.findingId === finding.id)
    return votes.filter(vote => vote.verdict === 'stands').length < 2 &&
      votes.every(vote => vote.verdict !== 'rejected')
  })

  while (extraSpent < preset.limits.extraVoteSessions) {
    const batch = needsSecond()
    if (batch.length === 0) break
    const reason = mayStartSession(preset.limits, state.used)
    if (reason) {
      state.notes.push(`verify：加票前${reason}，${batch.length} 条 Important 只有一票`)
      break
    }
    const slice = batch.slice(0, preset.limits.verifyBatchSize)
    const result = await deps.agents.run<SubmittedVerdict>({
      role: 'verifier',
      profile: 'verifier-second',
      prompt: `第二票独立核实：\n${slice.map(f => `- ${f.id} ${f.title} @ ${f.defectLocation.path}:${f.defectLocation.startLine}`).join('\n')}`,
      cwd: state.repoPath,
      readOnlyTools: ['read_file', 'glob', 'grep', 'working_directory'],
      submit: { name: 'submit_verdict', schema: VERIFIER_SUBMIT_SCHEMA, max: slice.length },
      budget: { maxTurns: preset.limits.verifierTurns, maxMs: preset.limits.verifierMs },
      signal: deps.signal,
    })
    state.used = charge(state.used, { ...result.usage, sessions: 1 })
    extraSpent += 1
    result.items.slice(0, slice.length).forEach((verdict, index) => {
      const finding = slice[index]
      if (!finding) return
      state.votes.push({
        findingId: finding.id,
        verifierSessionId: result.sessionId,
        verdict: verdict.verdict,
        reproducesOnBase: verdict.reproducesOnBase,
        evidence: verdict.evidence,
        at: new Date().toISOString(),
      })
    })
  }

  applyVerdicts(state)
  return undefined
}

/**
 * 计票并定状态。规则：Nit 一票成立即可；Important 需两票成立且没有"不成立"；
 * 不确定不发布，只在面板可见。
 */
export function applyVerdicts(state: PipelineState): void {
  for (const finding of state.findings) {
    if (finding.status !== 'candidate' && finding.status !== 'verified') continue
    const votes = state.votes.filter(vote => vote.findingId === finding.id)
    if (votes.length === 0) continue
    const stands = votes.filter(vote => vote.verdict === 'stands').length
    const rejected = votes.filter(vote => vote.verdict === 'rejected').length
    const uncertain = votes.filter(vote => vote.verdict === 'uncertain').length

    if (rejected > 0) { finding.status = 'rejected'; continue }
    if (uncertain > 0 && stands === 0) { finding.status = 'rejected'; continue }
    const needed = finding.severity === 'important' ? 2 : 1
    finding.status = stands >= needed ? 'verified' : 'rejected'
  }
}
