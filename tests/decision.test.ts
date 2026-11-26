/**
 * T9 的单测：决策包的门槛判定与渲染。
 *
 * 门槛判定必须是纯函数且可复算：任何人拿同一份数据算一遍，都应得到同一个建议。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  GATES, buildDecisionPackage, renderDecisionPackage, summarizeDispositions,
  type DecisionInput, type FeedbackRow,
} from '../src/app/decision.ts'

function feedback(verdict: FeedbackRow['verdict'], overrides: Partial<FeedbackRow> = {}): FeedbackRow {
  return {
    findingId: `f-${Math.random().toString(36).slice(2, 8)}`,
    verdict,
    title: '某条发现',
    severity: 'important',
    category: 'correctness',
    path: 'src/a.ts',
    runId: 'run-1',
    ...overrides,
  }
}

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    at: '2026-12-01T00:00:00Z',
    days: 6,
    runs: Array.from({ length: 5 }, (_, index) => ({
      id: `run-${index}`,
      repo: 'R/x',
      pr: index + 1,
      status: 'done',
      sessions: 2,
      turns: 3,
      durationMs: 1000,
    })),
    findings: Array.from({ length: 20 }, (_, index) => ({
      id: `f-${index}`,
      runId: 'run-0',
      title: '某条发现',
      severity: 'important',
      category: 'correctness',
      path: 'src/a.ts',
      status: 'published',
    })),
    feedback: [
      ...Array.from({ length: 8 }, () => feedback('valid')),
      ...Array.from({ length: 3 }, () => feedback('false-positive', { severity: 'nit' })),
      ...Array.from({ length: 1 }, () => feedback('intended')),
    ],
    ...overrides,
  }
}

// ---------- 处置汇总 ----------

test('处置汇总分别计数，并算出未处置比例', () => {
  const summary = summarizeDispositions(
    [feedback('valid'), feedback('valid'), feedback('false-positive'), feedback('unimportant')],
    10,
  )
  assert.equal(summary.total, 4)
  assert.equal(summary.valid, 2)
  assert.equal(summary.falsePositive, 1)
  assert.equal(summary.unimportant, 1)
  assert.equal(summary.undisposed, 0.6, '10 条发现里 4 条被处置，未处置 60%')
  assert.equal(summary.validRatio, 0.5)
})

test('零处置时不出除零', () => {
  const summary = summarizeDispositions([], 5)
  assert.equal(summary.validRatio, 0)
  assert.equal(summary.undisposed, 1)
})

// ---------- 门槛判定 ----------

test('样本充足且达标时建议发评论', () => {
  const pkg = buildDecisionPackage(input())
  assert.equal(pkg.recommendation, 'comment')
  assert.equal(pkg.gates.every(gate => gate.pass), true, JSON.stringify(pkg.gates))
})

test('成立占比偏低时建议先降噪', () => {
  const pkg = buildDecisionPackage(input({
    feedback: [
      ...Array.from({ length: 3 }, () => feedback('valid')),
      ...Array.from({ length: 9 }, () => feedback('false-positive', { severity: 'nit' })),
    ],
  }))
  assert.equal(pkg.recommendation, 'hold')
  assert.ok(pkg.reasons.some(reason => reason.includes('噪声偏高')))
})

test('Important 误报过多时建议先降噪', () => {
  const pkg = buildDecisionPackage(input({
    feedback: [
      ...Array.from({ length: 10 }, () => feedback('valid', { severity: 'nit' })),
      ...Array.from({ length: 8 }, () => feedback('false-positive', { severity: 'important' })),
    ],
  }))
  assert.equal(pkg.recommendation, 'hold')
  assert.ok(pkg.reasons.some(reason => reason.includes('有害修改')))
})

test('样本不足时不给建议，只让继续跑', () => {
  const pkg = buildDecisionPackage(input({ feedback: [feedback('valid')] }))
  assert.equal(pkg.recommendation, 'insufficient-data')
  assert.ok(pkg.reasons.some(reason => reason.includes('已处置样本')))
})

test('天数不足时同样判数据不足', () => {
  const pkg = buildDecisionPackage(input({ days: 2 }))
  assert.equal(pkg.recommendation, 'insufficient-data')
  assert.ok(pkg.reasons.some(reason => reason.includes('只跑了 2 天')))
})

test('门槛值可追溯到常量', () => {
  const pkg = buildDecisionPackage(input())
  const gate = pkg.gates.find(item => item.name === '成立占比')
  assert.equal(gate?.required, GATES.validRatio)
  const sample = pkg.gates.find(item => item.name === '已处置样本数')
  assert.equal(sample?.required, GATES.minDispositions)
})

// ---------- 典型例子与成本 ----------

test('典型好发现优先取 Important，坏发现取误报', () => {
  const pkg = buildDecisionPackage(input({
    feedback: [
      feedback('valid', { title: '一个重要缺陷', severity: 'important' }),
      feedback('valid', { title: '一个小问题', severity: 'nit' }),
      feedback('false-positive', { title: '误报的一条', severity: 'nit' }),
      ...Array.from({ length: 8 }, () => feedback('valid')),
    ],
  }))
  assert.equal(pkg.goodExamples[0].severity, 'important')
  assert.equal(pkg.badExamples[0].title, '误报的一条')
})

test('成本按运行累加', () => {
  const pkg = buildDecisionPackage(input())
  assert.equal(pkg.cost.sessions, 10)
  assert.equal(pkg.cost.turns, 15)
  assert.equal(pkg.cost.durationMs, 5000)
})

test('PR 数按仓库加编号去重', () => {
  const pkg = buildDecisionPackage(input())
  assert.equal(pkg.prs, 5)
})

// ---------- 渲染 ----------

test('渲染出结论、处置比例、门槛对照与成本', () => {
  const text = renderDecisionPackage(buildDecisionPackage(input()))
  assert.match(text, /## 结论：可以进入"发评论"阶段/)
  assert.match(text, /处置比例/)
  assert.match(text, /门槛对照/)
  assert.match(text, /典型好发现/)
  assert.match(text, /典型坏发现/)
  assert.match(text, /成本/)
  assert.match(text, /未处置/)
})
