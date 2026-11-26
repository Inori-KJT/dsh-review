/**
 * gate 与 publish。
 *
 * gate 是人闸门：初期打开，让人在面板上勾选哪些发现发出去；稳定后关闭。
 * 但有两类发现即使闸门关闭也一律 held —— 安全类 Important，以及改动规则文件的。
 * 理由是这两类错了的代价不对等：前者可能放过漏洞，后者能让规则被悄悄改掉。
 */
import type { PipelineState, StageFn } from '../core/run.ts'
import { sanitize } from '../core/sanitize.ts'
import type { Finding } from '../core/model.ts'

/** record 模式下任何写操作都必须抛这个，避免误发。 */
export class NotEnabled extends Error {
  constructor(what: string) {
    super(`${what} 在只读记录模式下未启用`)
    this.name = 'NotEnabled'
  }
}

export const gate: StageFn = async (state, _deps, preset) => {
  const candidates = state.findings.filter(finding => finding.status === 'verified')
  for (const finding of candidates) {
    // 安全类 Important 与规则改动一律等人，与闸门开关无关。
    if ((finding.category === 'security' && finding.severity === 'important') ||
        finding.category === 'review-config-change') {
      finding.status = 'held'
      state.gateWaiting.push(finding.id)
      continue
    }
    if (preset.gate) state.gateWaiting.push(finding.id)
  }
  return undefined
}

/** 只记录模式的发布：把"本会发出的内容"整理好并写进库，不向平台发任何写请求。 */
export const publish: StageFn = async (state) => {
  const publishable = state.findings.filter(finding => finding.status === 'verified')

  for (const finding of publishable) {
    // 两类发现即使闸门关闭也一律扣下：安全类 Important，以及改动规则文件的。
    // 这条规则放在 publish 而不是只放在 gate，因为 quick 档不跑 gate 阶段。
    if ((finding.category === 'security' && finding.severity === 'important') ||
        finding.category === 'review-config-change') {
      finding.status = 'held'
      if (!state.gateWaiting.includes(finding.id)) state.gateWaiting.push(finding.id)
      continue
    }
    // 最后一道外泄检查。命中则扣下，不静默丢弃。
    const combined = sanitize(`${finding.title}\n${finding.trigger}\n${finding.outcome}`)
    if (!combined.clean) {
      finding.status = 'held'
      if (!state.gateWaiting.includes(finding.id)) state.gateWaiting.push(finding.id)
      state.notes.push(`${finding.id} 命中脱敏规则 ${combined.hits.map(hit => hit.rule).join(',')}，已扣下`)
      continue
    }
    finding.status = 'published'
    state.published.push(finding)
  }

  if (state.run.mode !== 'record') {
    throw new NotEnabled(`${state.run.mode} 模式的发布`)
  }
  return undefined
}

/**
 * 摘要正文的形态：以问题计数开头，逐条给位置与一句话结论。
 * 即使只记录模式也会生成它，因为面板上看到的就是将来评论的形态。
 */
export function summaryBody(findings: readonly Finding[]): string {
  const important = findings.filter(finding => finding.severity === 'important').length
  const nit = findings.filter(finding => finding.severity === 'nit').length
  const preExisting = findings.filter(finding => finding.severity === 'pre-existing').length
  const head = `本次评审发现 ${findings.length} 条问题：${important} 条 Important，${nit} 条 Nit，${preExisting} 条为既有问题。`
  const lines = findings.map(finding =>
    `- \`${finding.defectLocation.path}:${finding.defectLocation.startLine}\` ${finding.title}（触发：${finding.trigger}；结果：${finding.outcome}）`)
  return [head, '', ...lines].join('\n')
}

/** 行内评论的正文：嵌入隐藏指纹标记，使去重与轮次可以从 PR 上直接算出来。 */
export function inlineBody(finding: Finding): string {
  return `${finding.title}\n\n触发条件：${finding.trigger}\n错误结果：${finding.outcome}\n\n<!-- dsh-review:${finding.fingerprint} v${finding.fingerprintVersion} -->`
}

/**
 * 新一轮推送后，把所在行已被改动的旧发现标为 stale。T2 只标记。
 */
export function markStale(previous: readonly Finding[], changedPaths: readonly string[]): Finding[] {
  const changed = new Set(changedPaths)
  const stale: Finding[] = []
  for (const finding of previous) {
    if (!changed.has(finding.defectLocation.path)) continue
    finding.status = 'stale'
    stale.push(finding)
  }
  return stale
}
