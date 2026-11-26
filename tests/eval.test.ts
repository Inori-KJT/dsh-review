/**
 * T8 的单测：用例挖掘、命中判定、四个指标、报告渲染。
 *
 * 挖掘与指标都是纯函数，因此这里不需要 git 也不需要模型。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  HIT_WINDOW, isHit, mineCases, mineCleanCases, renderEvalReport, summarize,
  type CaseResult, type CommitView, type EvalCase,
} from '../src/app/eval.ts'
import type { Finding } from '../src/core/model.ts'

function commit(overrides: Partial<CommitView> & { sha: string }): CommitView {
  return {
    parents: [],
    subject: '',
    body: '',
    at: '2026-09-01T00:00:00Z',
    changes: [],
    ...overrides,
  }
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'f-1',
    fingerprint: 'fp',
    fingerprintVersion: 1,
    headSha: 'head',
    runId: 'run',
    reviewKind: 'bug',
    category: 'correctness',
    severity: 'important',
    title: '问题',
    defectLocation: { path: 'src/a.ts', startLine: 10, endLine: 10 },
    trigger: '触发',
    outcome: '结果',
    causalEvidence: [],
    introducedByChange: 'yes',
    finderProfile: 'correctness',
    status: 'published',
    createdAt: '2026-11-26T00:00:00Z',
    updatedAt: '2026-11-26T00:00:00Z',
    ...overrides,
  }
}

// ---------- 挖掘：两类来源 ----------

test('revert 提交反推出被撤销的那次改动为用例', () => {
  const commits = [
    commit({ sha: 'aaaa1111', parents: ['p0'], subject: '添加了错误的默认值', changes: [{ path: 'src/a.ts', newStart: 12, lines: 3 }] }),
    commit({ sha: 'bbbb2222', parents: ['aaaa1111'], subject: 'Revert "添加了错误的默认值"', body: 'This reverts commit aaaa1111.' }),
  ]
  const cases = mineCases(commits)
  assert.equal(cases.length, 1)
  assert.equal(cases[0].source, 'revert')
  assert.equal(cases[0].headSha, 'aaaa1111', '用例的 head 应是引入缺陷的那个提交')
  assert.equal(cases[0].baseSha, 'p0')
  assert.deepEqual(cases[0].hints, [{ path: 'src/a.ts', line: 12 }])
  assert.match(cases[0].needsConfirmation, /确认/)
})

test('点名了引入者的修复提交反推出用例', () => {
  const commits = [
    commit({ sha: 'cccc3333', parents: ['p1'], subject: '改了循环边界', changes: [{ path: 'lib/x.js', newStart: 5, lines: 1 }] }),
    commit({ sha: 'dddd4444', parents: ['cccc3333'], subject: 'fix: 修复 cccc3333 引入的越界', changes: [{ path: 'lib/x.js', newStart: 5, lines: 1 }] }),
  ]
  const cases = mineCases(commits)
  assert.equal(cases.length, 1)
  assert.equal(cases[0].source, 'fix')
  assert.equal(cases[0].headSha, 'cccc3333')
  assert.deepEqual(cases[0].hints, [{ path: 'lib/x.js', line: 5 }])
})

test('没点名引入者的修复提交不采信', () => {
  const commits = [
    commit({ sha: 'eeee5555', parents: ['p2'], subject: 'fix: 一些改进' }),
    commit({ sha: 'ffff6666', parents: ['eeee5555'], subject: 'fix: 顺手修了一个问题' }),
  ]
  assert.equal(mineCases(commits).length, 0, '无法确定引入者时不应凭空生成用例')
})

test('同一提交被多个提交点名时只保留一个用例', () => {
  const commits = [
    commit({ sha: 'a1a1a1a1', parents: ['p'], subject: '引入问题的改动' }),
    commit({ sha: 'b1b1b1b1', subject: 'fix: 修复 a1a1a1a1 的问题' }),
    commit({ sha: 'c1c1c1c1', subject: 'Revert "某改动"', body: 'This reverts commit a1a1a1a1.' }),
  ]
  assert.equal(mineCases(commits).length, 1)
})

// ---------- 挖掘：干净集 ----------

test('干净集排除被 revert 的、太新的、以及文件被修复提交碰过的', () => {
  const now = Date.parse('2026-11-26T00:00:00Z')
  const commits = [
    commit({ sha: 'old11111', parents: ['p'], at: '2026-08-01T00:00:00Z', subject: '老改动', changes: [{ path: 'src/clean.ts', newStart: 1, lines: 5 }] }),
    commit({ sha: 'new22222', parents: ['p'], at: '2026-11-20T00:00:00Z', subject: '太新的改动', changes: [{ path: 'src/new.ts', newStart: 1, lines: 5 }] }),
    commit({ sha: 'fix33333', parents: ['p'], at: '2026-09-01T00:00:00Z', subject: 'fix: 修复老改动', changes: [{ path: 'src/clean.ts', newStart: 3, lines: 1 }] }),
    commit({ sha: 'rev44444', parents: ['p'], at: '2026-07-01T00:00:00Z', subject: 'Revert "x"', body: 'This reverts commit old11111.' }),
    commit({ sha: 'ok555555', parents: ['p'], at: '2026-07-15T00:00:00Z', subject: '干净的改动', changes: [{ path: 'src/ok.ts', newStart: 1, lines: 4 }] }),
  ]
  const clean = mineCleanCases(commits, { now })
  const ids = clean.map(item => item.id)
  assert.ok(ids.includes('clean-ok555555'), `干净提交应入选，实际 ${ids.join(',')}`)
  assert.ok(!ids.includes('clean-new22222'), '太新的不该入选')
  assert.ok(!ids.includes('clean-old11111'), '被 revert 的不该入选，其文件也被修复提交碰过')
})

// ---------- 命中判定 ----------

test('命中判定：同文件且相距十行以内', () => {
  const hints = [{ path: 'src/a.ts', line: 10 }]
  assert.equal(isHit(finding({ defectLocation: { path: 'src/a.ts', startLine: 10, endLine: 10 } }), hints), true)
  assert.equal(isHit(finding({ defectLocation: { path: 'src/a.ts', startLine: 10 + HIT_WINDOW, endLine: 20 } }), hints), true)
  assert.equal(isHit(finding({ defectLocation: { path: 'src/a.ts', startLine: 10 + HIT_WINDOW + 1, endLine: 30 } }), hints), false)
  assert.equal(isHit(finding({ defectLocation: { path: 'src/b.ts', startLine: 10, endLine: 10 } }), hints), false)
})

test('命中判定：只有文件没有行号时按文件算', () => {
  assert.equal(isHit(finding({ defectLocation: { path: 'src/a.ts', startLine: 999, endLine: 999 } }), [{ path: 'src/a.ts' }]), true)
})

// ---------- 四个指标 ----------

function result(overrides: Partial<CaseResult>): CaseResult {
  return {
    caseId: 'c',
    source: 'revert',
    runId: 'r',
    status: 'done',
    findingCount: 0,
    importantCount: 0,
    hits: 0,
    hintCount: 1,
    sessions: 2,
    turns: 3,
    durationMs: 1000,
    ...overrides,
  }
}

test('汇总：命中率与干净集误报数分开算', () => {
  const summary = summarize([
    result({ caseId: 'a', source: 'revert', hits: 1, hintCount: 1, importantCount: 1 }),
    result({ caseId: 'b', source: 'fix', hits: 0, hintCount: 1, importantCount: 2 }),
    result({ caseId: 'c', source: 'clean', hits: 0, hintCount: 0, importantCount: 0 }),
    result({ caseId: 'd', source: 'clean', hits: 0, hintCount: 0, importantCount: 2 }),
  ])
  assert.equal(summary.caseCount, 4)
  assert.equal(summary.hitRate, 0.5, '命中率只看缺陷集：命中 1 / 提示 2')
  assert.equal(summary.falsePositivePerPr, 1, '干净集两个 PR 共 2 条 Important，平均 1')
  assert.equal(summary.cost.sessions, 8)
  assert.equal(summary.cost.turns, 12)
})

test('汇总：没有干净集时误报数记 0 而不是除零', () => {
  const summary = summarize([result({ caseId: 'a', source: 'revert', hits: 1 })])
  assert.equal(summary.falsePositivePerPr, 0)
})

test('汇总：分来源统计', () => {
  const summary = summarize([
    result({ caseId: 'a', source: 'revert', hits: 1 }),
    result({ caseId: 'b', source: 'revert', hits: 0 }),
    result({ caseId: 'c', source: 'injected', hits: 1, hintCount: 1 }),
  ])
  assert.equal(summary.bySource.revert.cases, 2)
  assert.equal(summary.bySource.revert.hits, 1)
  assert.equal(summary.bySource.injected.cases, 1)
})

// ---------- 报告 ----------

test('报告含四个指标与需人工确认清单', () => {
  const cases: EvalCase[] = [
    { id: 'revert-abcd1234', source: 'revert', headSha: 'h', baseSha: 'b', hints: [{ path: 'a.ts', line: 1 }], evidence: 'e', needsConfirmation: '确认这件事' },
    { id: 'clean-efgh5678', source: 'clean', headSha: 'h2', baseSha: 'b2', hints: [], evidence: 'e2', needsConfirmation: '确认干净' },
  ]
  const results = [result({ caseId: 'revert-abcd1234', hits: 1 }), result({ caseId: 'clean-efgh5678', source: 'clean', hintCount: 0 })]
  const text = renderEvalReport({ cases, results, summary: summarize(results), configRevision: 3, at: '2026-11-26T00:00:00Z' })
  assert.match(text, /已知缺陷命中率/)
  assert.match(text, /干净集误报数/)
  assert.match(text, /平均轮次/)
  assert.match(text, /成本/)
  assert.match(text, /确认这件事/)
  assert.ok(!text.includes('确认干净'), '干净集用例不该出现在人工确认清单里')
})
