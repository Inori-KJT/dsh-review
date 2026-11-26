/**
 * T2 验收测试：整条流水线在假适配器上跑通。
 *
 * 覆盖任务书列出的八个场景，外加附录要求的三条增补。
 * 这里没有 DSH、没有 GitCode、没有网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { newRun, runPipeline } from '../src/core/run.ts'
import { stageTable, summaryBody, inlineBody, markStale, publish } from '../src/stages/index.ts'
import { PRESETS } from '../src/core/pipeline.ts'
import { applyVerdicts } from '../src/stages/agents.ts'
import { FakeVcs, FakeForge, FakeAgentRunner, sampleDiff, sampleFinding } from '../src/adapters/fakes.ts'
import { fingerprintV1, normalizeCode } from '../src/core/fingerprint.ts'
import { sanitize } from '../src/core/sanitize.ts'
import type { SubmittedVerdict } from '../src/core/ports.ts'

const BASE = 'aaa111'
const HEAD = 'bbb222'

function makeState(overrides: {
  depth?: 'quick' | 'standard' | 'deep'
  round?: number
  since?: string
  priorFindings?: Map<string, 'open' | 'false-positive' | 'intended' | 'unimportant' | 'resolved' | 'dismissed'>
} = {}) {
  return newRun({
    id: 'run-1',
    target: { kind: 'pr', repo: 'TokensService/demo', pr: 7 },
    repoPath: '/tmp/demo',
    repo: 'TokensService/demo',
    pr: 7,
    baseSha: BASE,
    headSha: HEAD,
    since: overrides.since,
    depth: overrides.depth ?? 'standard',
    mode: 'record',
    round: overrides.round ?? 1,
    priorFindings: overrides.priorFindings,
  })
}

function deps(config: {
  diff?: ReturnType<typeof sampleDiff>
  files?: Record<string, string>
  finders?: Record<string, ReturnType<typeof sampleFinding>[]>
  verify?: (request: unknown, batchIndex: number) => SubmittedVerdict[]
  budgetOut?: (request: unknown) => boolean
} = {}) {
  const vcs = new FakeVcs({ diff: config.diff ?? sampleDiff(), files: config.files })
  const forge = new FakeForge()
  const agents = new FakeAgentRunner(config as never)
  return { vcs, forge, agents, deps: { vcs, forge, agents } }
}

// ---------- 1 干净 PR ----------

test('干净 PR：无发现时运行完成且不发布任何东西', async () => {
  const { forge, deps: runDeps } = deps({ finders: { correctness: [], security: [] } })
  const state = await runPipeline(makeState(), runDeps, stageTable)
  assert.equal(state.run.status, 'done')
  assert.equal(state.published.length, 0)
  assert.equal(state.findings.length, 0)
  // record 模式绝不允许向平台写。
  assert.deepEqual(forge.writes, [])
})

// ---------- 2 去重 ----------

test('去重：同指纹的两条只保留一条', async () => {
  const same = sampleFinding()
  const { deps: runDeps } = deps({ finders: { correctness: [same, { ...same, title: '换个说法的同一个问题' }], security: [] } })
  const state = await runPipeline(makeState(), runDeps, stageTable)
  const real = state.findings.filter(finding => finding.category !== 'review-config-change')
  assert.equal(real.length, 1, `应只留一条，实际 ${real.length}`)
})

test('去重：同文件两处相同结论因序号不同而不合并', async () => {
  const first = sampleFinding({ line: 15, outcome: '在 a.ts:15 解引用时抛出 TypeError' })
  const second = sampleFinding({ line: 80, outcome: '在 a.ts:15 解引用时抛出 TypeError' })
  const { deps: runDeps } = deps({ finders: { correctness: [first, second], security: [] } })
  const state = await runPipeline(makeState(), runDeps, stageTable)
  const real = state.findings.filter(finding => finding.category !== 'review-config-change')
  assert.equal(real.length, 2, '同结论出现在两处应视为两个问题')
  assert.notEqual(real[0].fingerprint, real[1].fingerprint)
})

// ---------- 3 预算耗尽 ----------

test('预算耗尽：运行变 partial，未核实的标 unverified 且不发布', async () => {
  const { deps: runDeps } = deps({
    finders: { correctness: [sampleFinding()], security: [] },
    budgetOut: (request: unknown) => (request as { role: string }).role === 'finder',
  })
  const state = await runPipeline(makeState(), runDeps, stageTable)
  assert.equal(state.overflow, true)
  assert.equal(state.run.status, 'partial')
  for (const finding of state.published) {
    assert.notEqual(finding.status, 'unverified')
  }
})

test('会话数耗尽后不再起新会话，剩余候选标 unverified', async () => {
  // 三处 Nit 在 src/a.ts、一处 Important 在 src/b.ts。按文件就近分组得两批，
  // 而 quick 档只有一个核实席位，于是第二批（b.ts 那条）起不了核实会话，
  // 应标 unverified 并停在那一状态，绝不能被发布。
  const many = [
    sampleFinding({ path: 'src/a.ts', line: 12, outcome: 'a 文件第 1 处解引用', severity: 'nit' }),
    sampleFinding({ path: 'src/a.ts', line: 14, outcome: 'a 文件第 2 处解引用', severity: 'nit' }),
    sampleFinding({ path: 'src/a.ts', line: 16, outcome: 'a 文件第 3 处解引用', severity: 'nit' }),
    sampleFinding({ path: 'src/b.ts', line: 6, outcome: 'b 文件那一处', severity: 'important' }),
  ]
  const { deps: runDeps, agents } = deps({ finders: { correctness: many, security: [] } })
  const state = await runPipeline(makeState({ depth: 'quick' }), runDeps, stageTable)
  assert.ok(agents.calls.length <= 2, `quick 档最多 2 个会话，实际 ${agents.calls.length}`)
  const unverified = state.findings.filter(finding => finding.status === 'unverified')
  // find 阶段按严重度排序，Important 排在最前，因此第一批是它、第二批才是三处 Nit。
  assert.ok(unverified.length > 0,
    `应留下未核实项；实际状态 ${state.findings.map(f => f.status).join(',')}`)
  // 该场景下没有任何一条应当被发布：Important 只有一票（quick 无加票席位），
  // 三处 Nit 则因核实席位用尽停在 unverified。
  assert.equal(state.published.length, 0,
    `不应发布任何一条；实际发布 ${state.published.map(f => f.id).join(',')}`)
  for (const finding of state.published) {
    assert.notEqual(finding.status, 'unverified', '未核实的发现绝不能发布')
  }
})

// ---------- 4 投票规则 ----------

test('投票：Nit 一票成立即通过', async () => {
  const nit = sampleFinding({ severity: 'nit' })
  const { deps: runDeps } = deps({ finders: { correctness: [nit], security: [] } })
  const state = await runPipeline(makeState(), runDeps, stageTable)
  const target = state.findings.find(finding => finding.category === 'correctness')
  assert.equal(target?.status, 'published')
})

test('投票：Important 只有一票成立时被否决', async () => {
  const important = sampleFinding({ severity: 'important' })
  const { deps: runDeps } = deps({
    finders: { correctness: [important], security: [] },
    verify: request => {
      const max = (request as { submit: { max: number } }).submit.max
      return Array.from({ length: max }, () => ({ verdict: 'stands' as const, reproducesOnBase: 'no' as const }))
    },
  })
  const state = await runPipeline(makeState({ depth: 'quick' }), runDeps, stageTable)
  // quick 档没有加票席位，Important 拿不到第二票。
  const target = state.findings.find(finding => finding.category === 'correctness')
  assert.equal(target?.status, 'rejected')
})

test('投票：任意一票"不成立"即否决', async () => {
  const nit = sampleFinding({ severity: 'nit' })
  const { deps: runDeps } = deps({
    finders: { correctness: [nit], security: [] },
    verify: request => {
      const max = (request as { submit: { max: number } }).submit.max
      return Array.from({ length: max }, () => ({ verdict: 'rejected' as const, reproducesOnBase: 'no' as const }))
    },
  })
  const state = await runPipeline(makeState(), runDeps, stageTable)
  const target = state.findings.find(finding => finding.category === 'correctness')
  assert.equal(target?.status, 'rejected')
})

test('投票：不确定不发布', async () => {
  const nit = sampleFinding({ severity: 'nit' })
  const { deps: runDeps } = deps({
    finders: { correctness: [nit], security: [] },
    verify: request => {
      const max = (request as { submit: { max: number } }).submit.max
      return Array.from({ length: max }, () => ({ verdict: 'uncertain' as const, reproducesOnBase: 'unknown' as const }))
    },
  })
  const state = await runPipeline(makeState(), runDeps, stageTable)
  const target = state.findings.find(finding => finding.category === 'correctness')
  assert.notEqual(target?.status, 'published')
})

// ---------- 5 Pre-existing 判定 ----------

test('Pre-existing：三个条件齐才判既有', async () => {
  // 行号落在 diff 之外、finder 自报 no、verifier 说 base 上同样成立。
  const outside = sampleFinding({ line: 999, introducedByChange: 'no', severity: 'nit' })
  const { deps: runDeps } = deps({
    finders: { correctness: [outside], security: [] },
    verify: request => {
      const max = (request as { submit: { max: number } }).submit.max
      return Array.from({ length: max }, () => ({ verdict: 'stands' as const, reproducesOnBase: 'yes' as const }))
    },
  })
  const state = await runPipeline(makeState(), runDeps, stageTable)
  const target = state.findings.find(finding => finding.category === 'correctness')
  assert.equal(target?.severity, 'pre-existing')
})

test('Pre-existing：任一条不满足就按本 PR 引入处理', async () => {
  const inDiff = sampleFinding({ line: 15, introducedByChange: 'no' })
  const { deps: runDeps } = deps({
    finders: { correctness: [inDiff], security: [] },
    verify: request => {
      const max = (request as { submit: { max: number } }).submit.max
      return Array.from({ length: max }, () => ({ verdict: 'stands' as const, reproducesOnBase: 'yes' as const }))
    },
  })
  const state = await runPipeline(makeState(), runDeps, stageTable)
  const target = state.findings.find(finding => finding.category === 'correctness')
  // 行在本 PR 的 diff 里，因此不判 pre-existing。
  assert.notEqual(target?.severity, 'pre-existing')
})

test('Pre-existing：verifier 说不复现则按本 PR 引入处理', async () => {
  const outside = sampleFinding({ line: 999, introducedByChange: 'no' })
  const { deps: runDeps } = deps({
    finders: { correctness: [outside], security: [] },
    verify: request => {
      const max = (request as { submit: { max: number } }).submit.max
      return Array.from({ length: max }, () => ({ verdict: 'stands' as const, reproducesOnBase: 'no' as const }))
    },
  })
  const state = await runPipeline(makeState(), runDeps, stageTable)
  const target = state.findings.find(finding => finding.category === 'correctness')
  assert.notEqual(target?.severity, 'pre-existing')
})

// ---------- 6 脱敏 ----------

test('脱敏：正文含 token 的发现被扣下，不静默丢弃', async () => {
  const leaky = sampleFinding({
    title: '配置里写死了凭据',
    // 令牌形态在运行时拼出，源码里不留字面量：GitHub 的推送保护会拦下像真令牌的字符串。
    outcome: '发现一个形如 ' + ['ghp', 'FAKE'.repeat(8)].join('_') + ' 的令牌出现在 a.ts:15',
  })
  const { deps: runDeps } = deps({ finders: { correctness: [leaky], security: [] } })
  const state = await runPipeline(makeState(), runDeps, stageTable)
  const target = state.findings.find(finding => finding.category === 'correctness')
  assert.equal(target?.status, 'held', '命中密钥应扣下等人处理')
  assert.ok(!state.published.some(finding => finding.id === target?.id))
})

test('脱敏：私钥头、内网地址、家目录都被识别', () => {
  assert.equal(sanitize('-----BEGIN RSA PRIVATE KEY-----').clean, false)
  assert.equal(sanitize('访问 192.168.0.102 上的服务').clean, false)
  assert.equal(sanitize('文件在 /root/zhaochi/secret.txt').clean, false)
  assert.equal(sanitize('把返回值从 null 改成默认值').clean, true)
})

// ---------- 7 第 2 轮只审新 diff ----------

test('第 2 轮：diff 用 since..head，而不是 base..head', async () => {
  const mid = 'ccc333'
  const { vcs, deps: runDeps } = deps({ finders: { correctness: [], security: [] } })
  const state = makeState({ round: 2, since: mid })
  await runPipeline(state, runDeps, stageTable)
  assert.deepEqual(vcs.diffCalls, [{ base: mid, head: HEAD }])
})

test('第 1 轮：diff 用 base..head', async () => {
  const { vcs, deps: runDeps } = deps({ finders: { correctness: [], security: [] } })
  await runPipeline(makeState(), runDeps, stageTable)
  assert.deepEqual(vcs.diffCalls, [{ base: BASE, head: HEAD }])
})

// ---------- 8 第 3 轮只报 Important ----------

test('第 3 轮：Nit 被丢掉，只留 Important', async () => {
  const nit = sampleFinding({ severity: 'nit', line: 15, outcome: 'Nit 的一处小问题' })
  const important = sampleFinding({ severity: 'important', line: 62, outcome: 'Important 的一处问题' })
  const { deps: runDeps } = deps({ finders: { correctness: [nit, important], security: [] } })
  const state = await runPipeline(makeState({ round: 3 }), runDeps, stageTable)
  const correctness = state.findings.filter(finding => finding.category === 'correctness')
  const nitFinding = correctness.find(finding => finding.severity === 'nit' || finding.title.includes('小'))
  assert.ok(!state.published.some(finding => finding.severity === 'nit'), '第 3 轮不应发布 Nit')
  assert.ok(correctness.length > 0)
  assert.ok(nitFinding === undefined || nitFinding.status === 'dismissed')
})

// ---------- 附录增补 ----------

test('附录：PR 改动规则文件时生成一条 held 发现，且规则从 base 读', async () => {
  const diff = sampleDiff({ changedFiles: ['src/a.ts', 'REVIEW.md'] })
  const { vcs, deps: runDeps } = deps({
    diff,
    files: { [`${BASE}:REVIEW.md`]: '- 本目录不审安全问题', [`${HEAD}:REVIEW.md`]: '' },
    finders: { correctness: [], security: [] },
  })
  const state = await runPipeline(makeState(), runDeps, stageTable)
  const ruleFinding = state.findings.find(finding => finding.category === 'review-config-change')
  assert.ok(ruleFinding, '应生成规则改动发现')
  assert.equal(ruleFinding?.status, 'held')
  // 规则文件必须从 base 读。
  const ruleReads = vcs.ruleFileReads()
  assert.ok(ruleReads.every(read => read.sha === BASE), `规则文件读了 ${JSON.stringify(ruleReads)}`)
})

test('附录：安全类 Important 即使闸门关闭也 held', async () => {
  // quick 档不跑 security finder 也不跑 gate，所以直接测 publish 这条规则：
  // 一条已核实的安全类 Important 到 publish 时仍必须被扣下。
  const state = makeState({ depth: 'quick' })
  const security = {
    ...sampleShape(sampleFinding({
      category: 'security',
      severity: 'important',
      title: '路径穿越',
      trigger: '用户传入的 path 直接拼进文件读取',
      outcome: '可读取工作目录之外的任意文件',
    })),
    status: 'verified' as const,
  }
  state.findings.push(security as never)
  await publish(state, { vcs: new FakeVcs({ diff: sampleDiff() }), forge: new FakeForge(), agents: new FakeAgentRunner() }, PRESETS.quick)
  assert.equal(state.findings[0].status, 'held')
  assert.equal(state.published.length, 0)
  assert.ok(state.gateWaiting.includes('old-1'), '扣下的安全类发现应进入等你处理')
})

test('附录：已解决的指纹再次出现时作为新发现发布', async () => {
  const finding = sampleFinding({ severity: 'nit' })
  const fingerprint = fingerprintV1.of({
    path: finding.path, symbol: '', category: finding.category,
    code: normalizeCode(finding.outcome), ordinal: 1,
  })
  const prior = new Map<string, 'resolved'>([[fingerprint, 'resolved']])
  const { deps: runDeps } = deps({ finders: { correctness: [finding], security: [] } })
  const state = await runPipeline(makeState({ priorFindings: prior }), runDeps, stageTable)
  const again = state.findings.find(item => item.category === 'correctness')
  assert.ok(again, '已解决的同一问题再次出现应作为新发现')
})

test('附录：已判误报的指纹不再报', async () => {
  const finding = sampleFinding({ severity: 'nit' })
  const fingerprint = fingerprintV1.of({
    path: finding.path, symbol: '', category: finding.category,
    code: normalizeCode(finding.outcome), ordinal: 1,
  })
  const prior = new Map<string, 'false-positive'>([[fingerprint, 'false-positive']])
  const { deps: runDeps } = deps({ finders: { correctness: [finding], security: [] } })
  const state = await runPipeline(makeState({ priorFindings: prior }), runDeps, stageTable)
  assert.equal(state.findings.filter(item => item.category === 'correctness').length, 0)
})

test('附录：旧发现所在行被改动后标 stale', () => {
  const finding = sampleFinding()
  const state = makeState()
  const previous = [{ ...state.findings[0], ...sampleShape(finding) }]
  const stale = markStale(previous as never, ['src/a.ts'])
  assert.equal(stale.length, 1)
  assert.equal(stale[0].status, 'stale')
})

function sampleShape(input: ReturnType<typeof sampleFinding>) {
  return {
    id: 'old-1',
    fingerprint: 'fp-old',
    fingerprintVersion: 1,
    headSha: BASE,
    runId: 'run-0',
    reviewKind: 'bug' as const,
    category: input.category,
    severity: input.severity,
    title: input.title,
    defectLocation: { path: input.path, startLine: input.line, endLine: input.line },
    trigger: input.trigger,
    outcome: input.outcome,
    causalEvidence: [],
    introducedByChange: input.introducedByChange,
    finderProfile: 'correctness',
    status: 'published' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

// ---------- 摘要形态 ----------

test('摘要正文以问题计数开头', () => {
  const state = makeState()
  const body = summaryBody([{ ...sampleShape(sampleFinding()) }])
  assert.match(body, /^本次评审发现 1 条问题：1 条 Important/)
})

test('行内评论内嵌隐藏指纹标记', () => {
  const body = inlineBody({ ...sampleShape(sampleFinding()), fingerprint: 'abc123' })
  assert.match(body, /<!-- dsh-review:abc123 v1 -->/)
})

// ---------- applyVerdicts 单元 ----------

test('applyVerdicts：两票成立才让 Important 通过', () => {
  const state = makeState()
  // applyVerdicts 只处理 candidate 与 verified，因此这里必须显式给 candidate。
  state.findings.push({ ...sampleShape(sampleFinding({ severity: 'important' })), status: 'candidate' } as never)
  state.votes.push(
    { findingId: 'old-1', verifierSessionId: 'a', verdict: 'stands', reproducesOnBase: 'no', at: '' },
    { findingId: 'old-1', verifierSessionId: 'b', verdict: 'stands', reproducesOnBase: 'no', at: '' },
  )
  applyVerdicts(state)
  assert.equal(state.findings[0].status, 'verified')
})
