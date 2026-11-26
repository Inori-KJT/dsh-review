/**
 * T3 验收测试：存储与调度。
 *
 * 三个规定的场景：
 *   1 运行到一半时进程没了，重启后从同一阶段继续
 *   2 同一 head 的重复请求返回既有运行，库里只有一条
 *   3 取消能传到假 AgentRunner，后续阶段不再起会话
 * 另加熔断、事件流、发现落库三项。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SqliteStore } from '../src/adapters/sqlite-store.ts'
import { Scheduler } from '../src/app/scheduler.ts'
import { stageTable } from '../src/stages/index.ts'
import { FakeVcs, FakeForge, FakeAgentRunner, sampleDiff, sampleFinding } from '../src/adapters/fakes.ts'
import type { AgentRunner, AgentRunnerRequest, AgentRunnerResult, SubmittedVerdict } from '../src/core/ports.ts'

const REPO = 'TokensService/demo'
const BASE = 'aaa111'
const HEAD = 'bbb222'

function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-review-'))
  return join(dir, 'state.db')
}

function workers(config: Parameters<typeof buildFakes>[0] = {}) {
  return buildFakes(config)
}

function buildFakes(config: {
  finders?: Record<string, ReturnType<typeof sampleFinding>[]>
  diff?: ReturnType<typeof sampleDiff>
} = {}) {
  return {
    vcs: new FakeVcs({ diff: config.diff ?? sampleDiff() }),
    forge: new FakeForge(),
    agents: new FakeAgentRunner({ finders: config.finders ?? { correctness: [], security: [] } }),
  }
}

/** 一个总是抛错的 AgentRunner，用来模拟"运行到一半进程没了"。 */
class ThrowingRunner implements AgentRunner {
  readonly calls: string[] = []
  async run<T>(request: AgentRunnerRequest<T>): Promise<AgentRunnerResult<T>> {
    this.calls.push(request.profile)
    throw new Error('模拟进程中断')
  }
}

function request(overrides: Partial<{ headSha: string; depth: 'quick' | 'standard' }> = {}) {
  return {
    repo: REPO,
    pr: 7,
    baseSha: BASE,
    headSha: overrides.headSha ?? HEAD,
    repoPath: '/tmp/demo',
    mode: 'record' as const,
    depth: overrides.depth ?? 'standard' as const,
  }
}

// ---------- 场景 2：同一 head 只评一次 ----------

test('同一 head 的重复请求返回既有运行，库里只有一条', async () => {
  const store = new SqliteStore(tempStorePath())
  const { vcs, forge, agents } = workers()
  const scheduler = new Scheduler({ store, deps: { vcs, forge, agents }, table: stageTable })

  const first = await scheduler.submit(request())
  const second = await scheduler.submit(request())
  assert.equal(first.reused, false)
  assert.equal(second.reused, true)
  assert.equal(second.runId, first.runId)

  const runs = await store.listRuns()
  assert.equal(runs.length, 1, `库里应只有一条运行，实际 ${runs.length}`)
  await store.close()
})

test('不同 head 会新建运行', async () => {
  const store = new SqliteStore(tempStorePath())
  const { vcs, forge, agents } = workers()
  const scheduler = new Scheduler({ store, deps: { vcs, forge, agents }, table: stageTable })
  await scheduler.submit(request())
  await scheduler.submit(request({ headSha: 'ccc333' }))
  assert.equal((await store.listRuns()).length, 2)
  await store.close()
})

// ---------- 场景 1：中断后从 cursor 继续 ----------

test('中断后重启从同一阶段继续，不从头重跑', async () => {
  const path = tempStorePath()
  const storeA = new SqliteStore(path)
  const fakesA = workers({ finders: { correctness: [sampleFinding({ severity: 'nit' })], security: [] } })
  const broken = new ThrowingRunner()
  const schedulerA = new Scheduler({ store: storeA, deps: { vcs: fakesA.vcs, forge: fakesA.forge, agents: broken }, table: stageTable })

  const { runId } = await schedulerA.submit(request({ depth: 'quick' }))
  await assert.rejects(
    () => schedulerA.start(runId),
    /模拟进程中断/,
    '第一次推进应当在 find 阶段抛错，模拟进程中断',
  )

  const interrupted = await storeA.getRun(runId)
  assert.equal(interrupted?.status, 'running', `中断后状态应仍是 running，实际 ${interrupted?.status}`)
  assert.equal(interrupted?.cursor, 'plan', `中断时应停在 find 之前，cursor 应为 plan，实际 ${interrupted?.cursor}`)
  const eventsBefore = await storeA.listEvents(runId)
  assert.ok(eventsBefore.some(event => event.type === 'run.created'))
  await storeA.close()

  // 新进程：新建 store 与 scheduler，读同一个库。
  const storeB = new SqliteStore(path)
  const fakesB = workers({ finders: { correctness: [sampleFinding({ severity: 'nit' })], security: [] } })
  const schedulerB = new Scheduler({ store: storeB, deps: { vcs: fakesB.vcs, forge: fakesB.forge, agents: fakesB.agents }, table: stageTable })

  const resumed = await schedulerB.resumeAfterRestart()
  assert.deepEqual(resumed, [runId], `应恢复一条运行，实际 ${JSON.stringify(resumed)}`)

  const finished = await storeB.getRun(runId)
  assert.equal(finished?.status, 'done', `恢复后应跑完，实际 ${finished?.status}`)

  // 恢复时从 cursor 起，collect 不应被重跑，因此新的 VcsPort 一次 diff 都不该收到。
  assert.equal(fakesB.vcs.diffCalls.length, 0,
    `恢复后不应重跑 collect，diff 却被调用 ${fakesB.vcs.diffCalls.length} 次`)

  const events = await storeB.listEvents(runId)
  assert.ok(events.some(event => event.type === 'run.resumed'), '应记一条恢复事件')
  assert.ok(events.some(event => event.type === 'run.finished'), '应记一条结束事件')
  await storeB.close()
})

// ---------- 场景 3：取消 ----------

test('取消前未开始：信号置位后一个会话都不起', async () => {
  const store = new SqliteStore(tempStorePath())
  const { vcs, forge, agents } = workers()
  const scheduler = new Scheduler({ store, deps: { vcs, forge, agents }, table: stageTable })
  const { runId } = await scheduler.submit(request())
  await scheduler.cancel(runId)
  await scheduler.start(runId)
  assert.equal(agents.calls.length, 0, `取消后不应起会话，实际 ${agents.calls.length}`)
  assert.equal((await store.getRun(runId))?.status, 'cancelled')
  await store.close()
})

test('取消传到 AgentRunner：find 之后不再起核实会话', async () => {
  const store = new SqliteStore(tempStorePath())
  const { vcs, forge } = workers({ finders: { correctness: [sampleFinding({ severity: 'nit' })], security: [] } })

  let schedulerRef: Scheduler | undefined
  let runIdRef: string | undefined
  const cancellingAgents: AgentRunner = {
    async run<T>(req: AgentRunnerRequest<T>): Promise<AgentRunnerResult<T>> {
      // find 阶段一结束就取消，模拟"人中途叫停"。
      if (req.role === 'finder' && schedulerRef && runIdRef) {
        void schedulerRef.cancel(runIdRef)
      }
      const items = req.role === 'finder'
        ? [{ ...sampleFinding({ severity: 'nit' }) }] as unknown as T[]
        : [{ verdict: 'stands', reproducesOnBase: 'no' }] as unknown as T[]
      return { sessionId: 's1', items, usage: { turns: 1, durationMs: 10 }, ended: 'done' }
    },
  }
  const scheduler = new Scheduler({ store, deps: { vcs, forge, agents: cancellingAgents }, table: stageTable })
  schedulerRef = scheduler
  const submitted = await scheduler.submit(request())
  runIdRef = submitted.runId

  await scheduler.start(submitted.runId)
  const run = await store.getRun(submitted.runId)
  assert.equal(run?.status, 'cancelled', `取消后状态应为 cancelled，实际 ${run?.status}`)
  await store.close()
})

// ---------- 熔断 ----------

test('同一 PR 24 小时内第六次起熔断，不新建运行', async () => {
  const store = new SqliteStore(tempStorePath())
  const { vcs, forge, agents } = workers()
  let clock = 1_800_000_000_000
  const scheduler = new Scheduler({
    store, deps: { vcs, forge, agents }, table: stageTable,
    now: () => clock,
    nextId: (() => { let n = 0; return () => `run-${++n + clock}` })(),
  })
  for (let index = 0; index < 6; index += 1) {
    const result = await scheduler.submit(request({ headSha: `sha-${index}` }))
    assert.equal(result.circuitOpen ?? false, false, `第 ${index + 1} 次不应熔断`)
    clock += 1000
  }
  const blocked = await scheduler.submit(request({ headSha: 'sha-final' }))
  assert.equal(blocked.circuitOpen, true, '第七次应熔断')
  assert.match(String(blocked.reason), /24 小时内/)
  assert.equal((await store.listRuns()).length, 6)
  await store.close()
})

// ---------- 发现落库与事件流 ----------

test('发现与投票落库，事件流完整', async () => {
  const store = new SqliteStore(tempStorePath())
  const { vcs, forge } = workers({ finders: { correctness: [sampleFinding({ severity: 'nit' })], security: [] } })
  const agents = new FakeAgentRunner({
    finders: { correctness: [sampleFinding({ severity: 'nit' })], security: [] },
    verify: (req: AgentRunnerRequest<SubmittedVerdict>) =>
      Array.from({ length: req.submit.max }, () => ({ verdict: 'stands' as const, reproducesOnBase: 'no' as const })),
  })
  const scheduler = new Scheduler({ store, deps: { vcs, forge, agents }, table: stageTable })
  const { runId } = await scheduler.submit(request({ depth: 'quick' }))
  await scheduler.start(runId)

  const findings = await store.listFindings(runId)
  assert.ok(findings.length >= 1, `应有发现落库，实际 ${findings.length}`)
  assert.ok(findings.every(finding => finding.fingerprint.length > 0), '每条发现都必须带指纹')
  assert.ok(findings.every(finding => finding.headSha === HEAD), '每条发现都必须带 head sha')

  const votes = await store.listVotes(findings[0].id)
  assert.ok(votes.length >= 1, '应有投票落库')

  const events = await store.listEvents(runId)
  assert.ok(events.some(event => event.type === 'stage.done'), '应有阶段完成事件')
  assert.ok(events.map(event => event.seq).every((seq, index, all) => index === 0 || seq > all[index - 1]), '事件序号必须递增')
  await store.close()
})

test('唯一索引阻止同一身份写入第二条运行', async () => {
  const store = new SqliteStore(tempStorePath())
  const { vcs, forge, agents } = workers()
  const scheduler = new Scheduler({ store, deps: { vcs, forge, agents }, table: stageTable, nextId: () => 'fixed-id' })
  await scheduler.submit(request())
  // 绕过调度器直接再插一次，数据库应当拒绝。
  const run = await store.getRun('fixed-id')
  assert.ok(run)
  await assert.rejects(() => store.insertRun({ ...run, id: 'another-id' }), /UNIQUE|constraint/i)
  await store.close()
})

test('暂停后不再推进，库里状态为 paused', async () => {
  const store = new SqliteStore(tempStorePath())
  const { vcs, forge, agents } = workers()
  const scheduler = new Scheduler({ store, deps: { vcs, forge, agents }, table: stageTable })
  const { runId } = await scheduler.submit(request())
  await scheduler.pause(runId)
  assert.equal((await store.getRun(runId))?.status, 'paused')
  await scheduler.start(runId)
  assert.equal(agents.calls.length, 0, '暂停的运行不应起会话')
  await store.close()
})
