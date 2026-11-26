/**
 * 决策包。T9 试运行结束时交上去的那一页。
 *
 * 它回答四个问题：
 *   1 处置比例是多少——这是线上主指标，也几乎是唯一不受采样偏差影响的指标，因为它来自人。
 *   2 典型的好发现与坏发现各是哪几条——让人不必翻库就能判断质量。
 *   3 花了多少——会话、回合、耗时。
 *   4 要不要进入"发评论"阶段——给出门槛与判定，而不是一句"感觉还行"。
 *
 * 门槛用可调常量给出，判据必须可复算：任何人拿同一份数据算一遍，应得到同一个建议。
 */

export interface FeedbackRow {
  findingId: string
  verdict: 'valid' | 'false-positive' | 'intended' | 'unimportant'
  title: string
  severity: string
  category: string
  path: string
  runId: string
}

export interface DecisionInput {
  at: string
  runs: Array<{ id: string; repo: string; pr: number; status: string; sessions: number; turns: number; durationMs: number }>
  findings: Array<{
    id: string
    runId: string
    title: string
    severity: string
    category: string
    path: string
    status: string
  }>
  feedback: FeedbackRow[]
  /** 试运行覆盖的天数，用于判断样本是否够。 */
  days: number
}

/** 进入"发评论"阶段的四个门槛。改这里就是改决策规则。 */
export const GATES = {
  /** 已处置发现的成立占比下限。 */
  validRatio: 0.4,
  /** 每个 PR 平均 Important 误报数上限。 */
  importantFalsePerPr: 1.0,
  /** 至少要有多少条被人工处置过的发现，样本才算够。 */
  minDispositions: 10,
  /** 试运行至少覆盖多少天。 */
  minDays: 5,
} as const

export interface DispositionSummary {
  total: number
  valid: number
  falsePositive: number
  intended: number
  unimportant: number
  /** 未被处置的比例；高说明人没时间看，或面板不好用。 */
  undisposed: number
  validRatio: number
}

export interface DecisionPackage {
  at: string
  days: number
  runs: number
  prs: number
  findings: number
  disposition: DispositionSummary
  cost: { sessions: number; turns: number; durationMs: number }
  /** 典型好发现：被标为成立且严重度为 Important 的。 */
  goodExamples: FeedbackRow[]
  /** 典型坏发现：被标为误报的。 */
  badExamples: FeedbackRow[]
  /** 每个门槛的实际值与是否通过。 */
  gates: Array<{ name: string; actual: number; required: number; pass: boolean; note: string }>
  /** 最终建议。 */
  recommendation: 'comment' | 'hold' | 'insufficient-data'
  reasons: string[]
}

export function summarizeDispositions(feedback: readonly FeedbackRow[], findingCount: number): DispositionSummary {
  const valid = feedback.filter(row => row.verdict === 'valid').length
  const falsePositive = feedback.filter(row => row.verdict === 'false-positive').length
  const intended = feedback.filter(row => row.verdict === 'intended').length
  const unimportant = feedback.filter(row => row.verdict === 'unimportant').length
  const total = feedback.length
  return {
    total,
    valid,
    falsePositive,
    intended,
    unimportant,
    undisposed: findingCount === 0 ? 0 : Math.max(0, (findingCount - total) / findingCount),
    validRatio: total === 0 ? 0 : valid / total,
  }
}

export function buildDecisionPackage(input: DecisionInput): DecisionPackage {
  const prs = new Set(input.runs.map(run => `${run.repo}#${run.pr}`)).size
  const disposition = summarizeDispositions(input.feedback, input.findings.length)
  const importantFalse = input.feedback.filter(row => row.verdict === 'false-positive' && row.severity === 'important').length

  const gates: DecisionPackage['gates'] = [
    {
      name: '成立占比',
      actual: Number(disposition.validRatio.toFixed(3)),
      required: GATES.validRatio,
      pass: disposition.validRatio >= GATES.validRatio,
      note: '已处置发现里被标为成立的占比；低说明噪声大',
    },
    {
      name: '每个 PR 的 Important 误报数',
      actual: prs === 0 ? 0 : Number((importantFalse / prs).toFixed(3)),
      required: GATES.importantFalsePerPr,
      pass: prs > 0 && importantFalse / prs <= GATES.importantFalsePerPr,
      note: '会造成有害修改的噪声；越高越危险',
    },
    {
      name: '已处置样本数',
      actual: disposition.total,
      required: GATES.minDispositions,
      pass: disposition.total >= GATES.minDispositions,
      note: '样本太少时任何比例都不可信',
    },
    {
      name: '试运行天数',
      actual: input.days,
      required: GATES.minDays,
      pass: input.days >= GATES.minDays,
      note: '按任务书要求跑满 5 到 7 天',
    },
  ]

  const reasons: string[] = []
  let recommendation: DecisionPackage['recommendation']
  const sampleGate = gates[2]
  const daysGate = gates[3]

  if (!sampleGate.pass || !daysGate.pass) {
    recommendation = 'insufficient-data'
    if (!sampleGate.pass) reasons.push(`已处置样本只有 ${disposition.total} 条，少于 ${GATES.minDispositions} 条`)
    if (!daysGate.pass) reasons.push(`只跑了 ${input.days} 天，少于 ${GATES.minDays} 天`)
    reasons.push('亚样本下不给"发评论"的建议，先把时间跑够')
  } else if (gates[0].pass && gates[1].pass) {
    recommendation = 'comment'
    reasons.push(`成立占比 ${(disposition.validRatio * 100).toFixed(0)}% 不低于 ${(GATES.validRatio * 100).toFixed(0)}%`)
    reasons.push(`每个 PR 的 Important 误报数不高于 ${GATES.importantFalsePerPr}`)
  } else {
    recommendation = 'hold'
    if (!gates[0].pass) reasons.push(`成立占比 ${(disposition.validRatio * 100).toFixed(0)}% 低于 ${(GATES.validRatio * 100).toFixed(0)}%，噪声偏高`)
    if (!gates[1].pass) reasons.push(`每个 PR 的 Important 误报数超过 ${GATES.importantFalsePerPr}，会带来有害修改`)
    reasons.push('先按"报得多但都错"的方向收缩 finder 范围或提高判定门槛')
  }

  const goodExamples = input.feedback
    .filter(row => row.verdict === 'valid')
    .sort((a, b) => (a.severity === 'important' ? -1 : 1) - (b.severity === 'important' ? -1 : 1))
    .slice(0, 3)
  const badExamples = input.feedback.filter(row => row.verdict === 'false-positive' || row.verdict === 'unintended' as never).slice(0, 3)

  return {
    at: input.at,
    days: input.days,
    runs: input.runs.length,
    prs,
    findings: input.findings.length,
    disposition,
    cost: {
      sessions: input.runs.reduce((sum, run) => sum + run.sessions, 0),
      turns: input.runs.reduce((sum, run) => sum + run.turns, 0),
      durationMs: input.runs.reduce((sum, run) => sum + run.durationMs, 0),
    },
    goodExamples,
    badExamples,
    gates,
    recommendation,
    reasons,
  }
}

const RECOMMENDATION_LABEL: Record<DecisionPackage['recommendation'], string> = {
  comment: '可以进入"发评论"阶段',
  hold: '暂不进入，先降噪',
  'insufficient-data': '数据不足，继续跑',
}

export function renderDecisionPackage(pkg: DecisionPackage): string {
  const percent = (value: number) => `${(value * 100).toFixed(0)}%`
  return [
    `# dsh-review T9 决策包`,
    '',
    `生成时间 ${pkg.at} · 试运行 ${pkg.days} 天 · ${pkg.runs} 次运行 · ${pkg.prs} 个 PR · ${pkg.findings} 条发现`,
    '',
    `## 结论：${RECOMMENDATION_LABEL[pkg.recommendation]}`,
    '',
    ...pkg.reasons.map(reason => `- ${reason}`),
    '',
    '## 处置比例（线上主指标）',
    '',
    '| 处置 | 条数 | 占比 |',
    '| --- | --- | --- |',
    `| 成立 | ${pkg.disposition.valid} | ${percent(pkg.disposition.total === 0 ? 0 : pkg.disposition.valid / pkg.disposition.total)} |`,
    `| 误报 | ${pkg.disposition.falsePositive} | ${percent(pkg.disposition.total === 0 ? 0 : pkg.disposition.falsePositive / pkg.disposition.total)} |`,
    `| 有意为之 | ${pkg.disposition.intended} | ${percent(pkg.disposition.total === 0 ? 0 : pkg.disposition.intended / pkg.disposition.total)} |`,
    `| 不重要 | ${pkg.disposition.unimportant} | ${percent(pkg.disposition.total === 0 ? 0 : pkg.disposition.unimportant / pkg.disposition.total)} |`,
    `| 未处置 | — | ${percent(pkg.disposition.undisposed)} |`,
    '',
    `已处置 ${pkg.disposition.total} 条，成立占比 **${percent(pkg.disposition.validRatio)}**。`,
    '',
    '## 门槛对照',
    '',
    '| 门槛 | 实测 | 要求 | 是否通过 | 说明 |',
    '| --- | --- | --- | --- | --- |',
    ...pkg.gates.map(gate => `| ${gate.name} | ${gate.actual} | ${gate.required} | ${gate.pass ? '通过' : '未通过'} | ${gate.note} |`),
    '',
    '## 典型好发现',
    '',
    ...(pkg.goodExamples.length === 0
      ? ['（暂无）']
      : pkg.goodExamples.map(row => `- \`${row.path}\` **${row.title}**（${row.severity} / ${row.category}）`)),
    '',
    '## 典型坏发现',
    '',
    ...(pkg.badExamples.length === 0
      ? ['（暂无）']
      : pkg.badExamples.map(row => `- \`${row.path}\` ${row.title}（被判误报）`)),
    '',
    '## 成本',
    '',
    `会话 ${pkg.cost.sessions} · 回合 ${pkg.cost.turns} · 累计耗时 ${Math.round(pkg.cost.durationMs / 1000)} 秒（${(pkg.cost.durationMs / 3_600_000).toFixed(2)} 小时）`,
    '',
  ].join('\n')
}
