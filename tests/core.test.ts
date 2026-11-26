/**
 * T1 的验收测试。三组：
 *   1 指纹对空白与行号偏移稳定，且不同位置不合并
 *   2 预算记账与档位自洽
 *   3 八条不变量逐条
 * 另加一条结构性测试：core 不 import 任何外部 I/O 或宿主包。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { sha1Hex, normalizeCode, fingerprintV1 } from '../src/core/fingerprint.ts'
import { BUDGETS, verifySessionsNeeded, mayStartSession, exhausted, charge, emptyUsed, oversize } from '../src/core/budget.ts'
import {
  invariantRunSource, invariantOneRunPerHead, invariantRoundCap, roundWindow, severitiesForRound,
  invariantFingerprintLifecycle, invariantIgnoreOwnComments, invariantSelfReviewQuota,
  invariantSelfReviewSilent, invariantCircuitBreaker, MAX_ROUNDS,
} from '../src/core/invariants.ts'
import { STAGE_ORDER, STAGE_KIND, PRESETS, nextStage, stageEnabled } from '../src/core/pipeline.ts'

// ---------- 1 指纹 ----------

test('sha1 与标准向量一致', () => {
  assert.equal(sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709')
  assert.equal(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d')
  assert.equal(sha1Hex('a'.repeat(1000)).length, 40)
})

test('规范化吸收空白差异，但保留行序', () => {
  const a = normalizeCode('  const x = 1  \n\n    return x\n')
  const b = normalizeCode('const x = 1\nreturn x')
  assert.equal(a, b)
})

test('规范化丢弃纯注释行', () => {
  assert.equal(normalizeCode('// 说明\nconst x = 1'), 'const x = 1')
  assert.equal(normalizeCode('# 说明\nconst x = 1'), 'const x = 1')
})

test('指纹对空白与缩进变化稳定', () => {
  const base = { path: 'src/a.ts', symbol: 'f', category: 'correctness' as const, ordinal: 1 }
  const f1 = fingerprintV1.of({ ...base, code: 'const x = 1\nreturn x' })
  const f2 = fingerprintV1.of({ ...base, code: '  const x = 1\n\treturn x  ' })
  assert.equal(f1, f2)
})

test('指纹不含行号，因此行号偏移不改变它', () => {
  const input = { path: 'src/a.ts', symbol: 'f', category: 'correctness' as const, code: 'return x', ordinal: 1 }
  assert.equal(fingerprintV1.of(input), fingerprintV1.of({ ...input }))
})

test('同文件内两处相同片段因序号不同而不合并', () => {
  const base = { path: 'src/a.ts', symbol: 'f', category: 'correctness' as const, code: 'return x' }
  assert.notEqual(fingerprintV1.of({ ...base, ordinal: 1 }), fingerprintV1.of({ ...base, ordinal: 2 }))
})

test('路径、符号或类别变化会改变指纹', () => {
  const base = { path: 'src/a.ts', symbol: 'f', category: 'correctness' as const, code: 'return x', ordinal: 1 }
  const original = fingerprintV1.of(base)
  assert.notEqual(original, fingerprintV1.of({ ...base, path: 'src/b.ts' }))
  assert.notEqual(original, fingerprintV1.of({ ...base, symbol: 'g' }))
  assert.notEqual(original, fingerprintV1.of({ ...base, category: 'security' }))
})

// ---------- 2 预算 ----------

test('三档的会话数与核实批次数自洽', () => {
  for (const [depth, limits] of Object.entries(BUDGETS)) {
    const verify = verifySessionsNeeded(limits, limits.candidateCap)
    const total = limits.finders + verify + limits.extraVoteSessions
    assert.ok(total <= limits.sessionCap,
      `${depth}: finder ${limits.finders} + verify ${verify} + extra ${limits.extraVoteSessions} = ${total} 超过上限 ${limits.sessionCap}`)
  }
})

test('quick 档 5 条候选只需一个核实会话', () => {
  assert.equal(verifySessionsNeeded(BUDGETS.quick, 5), 1)
  assert.equal(verifySessionsNeeded(BUDGETS.quick, 3), 1)
})

test('standard 档 10 条候选需要两个核实会话', () => {
  assert.equal(verifySessionsNeeded(BUDGETS.standard, 10), 2)
})

test('候选数超过档位上限时按上限算', () => {
  assert.equal(verifySessionsNeeded(BUDGETS.quick, 999), 1)
})

test('会话数达上限时拒绝起新会话', () => {
  const limits = BUDGETS.quick
  assert.equal(mayStartSession(limits, { sessions: 0, turns: 0, tokens: 0, elapsedMs: 0 }), undefined)
  assert.match(String(mayStartSession(limits, { sessions: limits.sessionCap, turns: 0, tokens: 0, elapsedMs: 0 })), /会话数已达上限/)
})

test('耗时达上限时拒绝起新会话，并判为耗尽', () => {
  const limits = BUDGETS.quick
  const used = { sessions: 0, turns: 0, tokens: 0, elapsedMs: limits.timeCapMs }
  assert.match(String(mayStartSession(limits, used)), /耗时已达上限/)
  assert.equal(exhausted(limits, used), true)
})

test('token 达上限时判为耗尽', () => {
  const limits = BUDGETS.quick
  assert.equal(exhausted(limits, { sessions: 0, turns: 0, tokens: limits.tokenCap, elapsedMs: 0 }), true)
  assert.equal(exhausted(limits, { sessions: 0, turns: 0, tokens: 0, elapsedMs: 0 }), false)
})

test('记账累加会话与 token，耗时取最大值', () => {
  const used = charge(charge(emptyUsed(), { durationMs: 100 }), { durationMs: 50, tokens: 30 })
  assert.equal(used.sessions, 2)
  assert.equal(used.tokens, 30)
  assert.equal(used.elapsedMs, 100)
})

test('超大 PR 判定按行数与文件数两个阈值', () => {
  assert.equal(oversize(1501, 1), true)
  assert.equal(oversize(1, 41), true)
  assert.equal(oversize(1500, 40), false)
})

// ---------- 3 不变量 ----------

test('第 1 条：只有 head 变化与自审能起运行', () => {
  assert.equal(invariantRunSource('head-changed').allowed, true)
  assert.equal(invariantRunSource('self-review').allowed, true)
  for (const event of ['comment', 'reply', 'thread-resolved'] as const) {
    const verdict = invariantRunSource(event)
    assert.equal(verdict.allowed, false)
    assert.equal(verdict.code, 'notACodeChange')
  }
})

test('第 2 条：同一 head 已有运行则不再起', () => {
  assert.equal(invariantOneRunPerHead(undefined).allowed, true)
  const verdict = invariantOneRunPerHead('run-1')
  assert.equal(verdict.allowed, false)
  assert.match(String(verdict.reason), /run-1/)
})

test('第 3 条：三轮以内允许，第四轮转 needs_human', () => {
  for (const round of [1, 2, 3]) assert.equal(invariantRoundCap(round, 'bug').allowed, true)
  const verdict = invariantRoundCap(MAX_ROUNDS + 1, 'bug')
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.code, 'roundCapReached')
})

test('第 3 条：第 2 轮起只看上次评审以来的差异', () => {
  assert.deepEqual(roundWindow(1, undefined), {})
  assert.deepEqual(roundWindow(1, 'sha-a'), {})
  assert.deepEqual(roundWindow(2, 'sha-a'), { since: 'sha-a' })
  assert.deepEqual(roundWindow(3, 'sha-b'), { since: 'sha-b' })
})

test('第 3 条：第 3 轮只报 Important', () => {
  assert.deepEqual(severitiesForRound(1), ['important', 'nit'])
  assert.deepEqual(severitiesForRound(3), ['important'])
})

test('第 4 条：未解决的指纹不重复发布，误报与有意为之永久静音', () => {
  assert.equal(invariantFingerprintLifecycle(undefined).allowed, true)
  assert.equal(invariantFingerprintLifecycle('open').allowed, false)
  assert.equal(invariantFingerprintLifecycle('false-positive').allowed, false)
  assert.equal(invariantFingerprintLifecycle('intended').allowed, false)
  assert.equal(invariantFingerprintLifecycle('dismissed').allowed, false)
  // 已解决的再次被发现，作为新发现发布。
  assert.equal(invariantFingerprintLifecycle('resolved').allowed, true)
})

test('第 5 条：忽略自己账号与名单内机器人', () => {
  assert.equal(invariantIgnoreOwnComments('someone', ['self'], ['bot']).allowed, true)
  assert.equal(invariantIgnoreOwnComments('self', ['self'], ['bot']).code, 'ownAccount')
  assert.equal(invariantIgnoreOwnComments('bot', ['self'], ['bot']).code, 'reviewBot')
})

test('第 6 条：同一 head 只自审一次，一小时内最多两次', () => {
  const now = 1_000_000
  assert.equal(invariantSelfReviewQuota({ times: [], heads: [] }, 'sha-a', now).allowed, true)
  assert.equal(invariantSelfReviewQuota({ times: [], heads: ['sha-a'] }, 'sha-a', now).code, 'headAlreadySelfReviewed')
  const twice = { times: [now - 1000, now - 2000], heads: ['sha-x', 'sha-y'] }
  assert.equal(invariantSelfReviewQuota(twice, 'sha-z', now).code, 'selfReviewQuota')
  // 超过一小时的旧记录不再计入。
  const stale = { times: [now - 3_600_001, now - 7_200_000], heads: ['sha-x', 'sha-y'] }
  assert.equal(invariantSelfReviewQuota(stale, 'sha-z', now).allowed, true)
})

test('第 7 条：自审结果不发出去', () => {
  assert.equal(invariantSelfReviewSilent('self-review').allowed, false)
  assert.equal(invariantSelfReviewSilent('poll').allowed, true)
})

test('第 8 条：24 小时内第六次起触发熔断', () => {
  assert.equal(invariantCircuitBreaker(5).allowed, true)
  const verdict = invariantCircuitBreaker(6)
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.code, 'circuitOpen')
})

// ---------- 4 流水线与结构 ----------

test('阶段顺序固定为九段', () => {
  assert.equal(STAGE_ORDER.length, 9)
  assert.equal(STAGE_ORDER[0], 'collect')
  assert.equal(STAGE_ORDER[8], 'publish')
})

test('只有 find 与 verify 是 agent 阶段', () => {
  const agentStages = STAGE_ORDER.filter(stage => STAGE_KIND[stage] === 'agent')
  assert.deepEqual(agentStages, ['find', 'verify'])
})

test('quick 档跳过 gate', () => {
  assert.equal(stageEnabled('quick', 'gate'), false)
  assert.equal(stageEnabled('standard', 'gate'), true)
})

test('nextStage 走到末端返回 undefined', () => {
  assert.equal(nextStage('standard', 'collect'), 'plan')
  assert.equal(nextStage('standard', 'publish'), undefined)
  // quick 没有 gate，filter 之后直接到 publish。
  assert.equal(nextStage('quick', 'filter'), 'publish')
})

test('每个档位的 finder 数不超过 finderProfiles 的长度', () => {
  for (const preset of Object.values(PRESETS)) {
    assert.ok(preset.limits.finders <= preset.finderProfiles.length,
      `${preset.depth}: finders ${preset.limits.finders} 多于 profile 数 ${preset.finderProfiles.length}`)
  }
})

// ---------- 5 手写实现的等价性 ----------

test('自写 UTF-8 编码与 Node Buffer 一致', async () => {
  const { utf8Bytes } = await import('../src/core/fingerprint.ts')
  const { Buffer } = await import('node:buffer')
  for (const sample of ['', 'abc', '中文测试', 'emoji 🎯 混排', 'a'.repeat(1000), 'const x = 1\nreturn x']) {
    assert.equal(Buffer.from(utf8Bytes(sample)).toString('hex'), Buffer.from(sample, 'utf8').toString('hex'),
      `UTF-8 编码不一致: ${JSON.stringify(sample.slice(0, 20))}`)
  }
})

test('自写 sha1 与 node:crypto 一致', async () => {
  const { sha1Hex } = await import('../src/core/fingerprint.ts')
  const { createHash } = await import('node:crypto')
  for (const sample of ['', 'abc', '中文测试', 'emoji 🎯 混排', 'a'.repeat(1000), 'multi\nline\ntext']) {
    assert.equal(sha1Hex(sample), createHash('sha1').update(sample, 'utf8').digest('hex'),
      `sha1 不一致: ${JSON.stringify(sample.slice(0, 20))}`)
  }
})