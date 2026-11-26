/**
 * T6 的单测：轮询触发与 GitCode 只读适配器。
 *
 * 触发器部分验证不变量：只有 head 变化建运行；评论不建运行；第 N 轮带 since。
 * 适配器部分用假的 fetch 验证 GitCode 返回结构被正确解析，且三个写方法一律拒绝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PollingTrigger } from '../src/app/trigger.ts'
import { GitCodeForge, NotEnabled } from '../src/adapters/gitcode-forge.ts'
import type { Run } from '../src/core/model.ts'
import type { PullSummary } from '../src/core/ports.ts'

/** 可编排的 Forge，只实现触发器需要的读取方法。 */
class StubForge {
  pulls: PullSummary[] = []
  comments: Array<{ id: string; author: string; body: string; at: string }> = []
  commentReads = 0

  async listPulls(): Promise<PullSummary[]> { return this.pulls }
  async getPull(): Promise<undefined> { return undefined }
  async listComments() { this.commentReads += 1; return this.comments }
  async readMergeable() { return { mergeable: true, conflictPassed: true } }
  async postInline() {}
  async postSummary() {}
  async setStatus() {}
  async listReplies() { return [] }
}

function pull(number: number, headSha: string, baseSha = 'base-sha'): PullSummary {
  return { number, headSha, baseSha, author: 'someone', updatedAt: '2026-11-26T00:00:00Z' }
}

function runOf(overrides: Partial<Run>): Run {
  return {
    id: 'run-x',
    target: { kind: 'pr', repo: 'R/x', pr: 1 },
    repo: 'R/x',
    repoPath: '/tmp/x',
    pr: 1,
    baseSha: 'base-sha',
    headSha: 'head-1',
    reviewKind: 'bug',
    depth: 'standard',
    mode: 'record',
    round: 1,
    status: 'done',
    cursor: 'publish',
    configRevision: 1,
    trigger: 'poll',
    usage: { sessions: 0, turns: 0, durationMs: 0 },
    createdAt: '2026-11-26T00:00:00Z',
    updatedAt: '2026-11-26T00:00:00Z',
    ...overrides,
  }
}

function triggerWith(input: {
  forge: StubForge
  runs: Run[]
  submitted?: Array<{ repo: string; pr: number; headSha: string; since?: string; round?: number }>
  started?: string[]
}) {
  const submitted = input.submitted ?? []
  const started = input.started ?? []
  const instance = new PollingTrigger({
    forge: input.forge as never,
    submit: async request => {
      submitted.push({
        repo: request.repo,
        pr: request.pr,
        headSha: request.headSha,
        since: request.since,
        round: request.round,
      })
      return { runId: `run-${submitted.length}`, reused: false }
    },
    listRuns: async () => input.runs,
    repoPathFor: () => '/tmp/x',
    targets: [{ repo: 'R/x' }],
    start: async runId => { started.push(runId) },
  })
  return { instance, submitted, started }
}

test('提交之后自动推进新运行，复用的不重复推进', async () => {
  const forge = new StubForge()
  forge.pulls = [pull(1, 'head-2'), pull(2, 'head-9')]
  const started: string[] = []
  const { instance } = triggerWith({
    forge,
    runs: [runOf({ pr: 1, headSha: 'head-1' })],
    started,
  })
  await instance.pollOnce()
  assert.equal(started.length, 2, `应推进两次，实际 ${started.length}`)
})

// ---------- 触发器 ----------

test('head 未变时不建运行', async () => {
  const forge = new StubForge()
  forge.pulls = [pull(1, 'head-1')]
  const { instance, submitted } = triggerWith({ forge, runs: [runOf({ headSha: 'head-1' })] })
  const outcome = await instance.pollOnce()
  assert.equal(submitted.length, 0)
  assert.equal(outcome.unchanged, 1)
})

test('head 变化时建第 2 轮，且 since 等于上一轮 head', async () => {
  const forge = new StubForge()
  forge.pulls = [pull(1, 'head-2')]
  const { instance, submitted } = triggerWith({ forge, runs: [runOf({ headSha: 'head-1', round: 1 })] })
  const outcome = await instance.pollOnce()
  assert.equal(submitted.length, 1)
  assert.equal(outcome.submitted[0].round, 2)
  assert.equal(submitted[0].since, 'head-1', 'since 必须是上一轮的 head')
  assert.equal(submitted[0].headSha, 'head-2')
})

test('首次见到该 PR 时是第 1 轮，没有 since', async () => {
  const forge = new StubForge()
  forge.pulls = [pull(9, 'head-9')]
  const { instance, submitted } = triggerWith({ forge, runs: [] })
  await instance.pollOnce()
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].round, 1)
  assert.equal(submitted[0].since, undefined)
})

test('评论不建运行，而且触发器根本不读评论', async () => {
  const forge = new StubForge()
  forge.pulls = [pull(1, 'head-1')]
  forge.comments = [{ id: 'c1', author: 'x', body: '请评审这个 PR', at: '2026-11-26T00:00:00Z' }]
  const { instance, submitted } = triggerWith({ forge, runs: [runOf({ headSha: 'head-1' })] })
  const outcome = await instance.pollOnce()
  assert.equal(submitted.length, 0, '只有评论不该产生运行')
  assert.equal(outcome.submitted.length, 0)
  assert.equal(forge.commentReads, 0, '触发器不应读取评论，这是结构上的保证')
})

test('多个 PR 各自独立计轮次', async () => {
  const forge = new StubForge()
  forge.pulls = [pull(1, 'a2'), pull(2, 'b1')]
  const { instance } = triggerWith({
    forge,
    runs: [runOf({ pr: 1, headSha: 'a1', round: 1 }), runOf({ id: 'r2', pr: 2, headSha: 'b0', round: 1 })],
  })
  const outcome = await instance.pollOnce()
  const byPr = new Map(outcome.submitted.map(item => [item.pr, item]))
  assert.equal(byPr.get(1)?.round, 2)
  assert.equal(byPr.get(1)?.since, 'a1')
  assert.equal(byPr.get(2)?.round, 2)
})

test('熔断被拦下时不报成已提交', async () => {
  const forge = new StubForge()
  forge.pulls = [pull(1, 'head-2')]
  const instance = new PollingTrigger({
    forge: forge as never,
    submit: async () => ({ runId: '', reused: false, circuitOpen: true, reason: '该 PR 24 小时内已运行 6 次' }),
    listRuns: async () => [runOf({ headSha: 'head-1' })],
    repoPathFor: () => '/tmp/x',
    targets: [{ repo: 'R/x' }],
  })
  const outcome = await instance.pollOnce()
  assert.equal(outcome.submitted.length, 0)
  assert.equal(outcome.blocked.length, 1)
  assert.match(String(outcome.blocked[0].reason), /24 小时/)
})

// ---------- GitCode 适配器 ----------

const PULL_JSON = {
  number: 312,
  title: '安装 EMS 时应用 SSD 和 RoCE 参数',
  body: '本次改动说明',
  state: 'open',
  mergeable: true,
  conflict_passed: true,
  head: { sha: 'bc208bb6770b7277518265fad3731a36050d960a', ref: 'feat/x' },
  base: { sha: '72f30d3047cc997d53793ad3be611ce2149aaf65', ref: 'main' },
  user: { login: 'Zuocx_95' },
  updated_at: '2026-11-26T02:00:00Z',
}

function fakeFetch(payload: unknown, status = 200) {
  const calls: string[] = []
  const impl = (async (input: string | URL) => {
    calls.push(String(input))
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

test('listPulls 解析出 head/base/author', async () => {
  const { impl, calls } = fakeFetch([PULL_JSON])
  const forge = new GitCodeForge({ token: 'test-token', fetchImpl: impl })
  const pulls = await forge.listPulls({ repo: 'TokensService/tokens-worktable', state: 'open' })
  assert.equal(pulls.length, 1)
  assert.equal(pulls[0].number, 312)
  assert.equal(pulls[0].headSha, PULL_JSON.head.sha)
  assert.equal(pulls[0].baseSha, PULL_JSON.base.sha)
  assert.equal(pulls[0].author, 'Zuocx_95')
  // 令牌只出现在请求 URL 的查询参数里。
  assert.match(calls[0], /access_token=test-token/)
})

test('getPull 返回标题与描述', async () => {
  const { impl } = fakeFetch(PULL_JSON)
  const forge = new GitCodeForge({ token: 't', fetchImpl: impl })
  const pull = await forge.getPull('R/x', 312)
  assert.equal(pull?.title, PULL_JSON.title)
  assert.equal(pull?.description, PULL_JSON.body)
})

test('getPull 遇到 404 返回 undefined 而不是抛错', async () => {
  const { impl } = fakeFetch({ message: 'not found' }, 404)
  const forge = new GitCodeForge({ token: 't', fetchImpl: impl })
  assert.equal(await forge.getPull('R/x', 999), undefined)
})

test('readMergeable 读两个字段', async () => {
  const { impl } = fakeFetch(PULL_JSON)
  const forge = new GitCodeForge({ token: 't', fetchImpl: impl })
  const state = await forge.readMergeable('R/x', 312)
  assert.equal(state.mergeable, true)
  assert.equal(state.conflictPassed, true)
})

test('三个写方法在只读模式下一律抛 NotEnabled', async () => {
  const { impl } = fakeFetch([])
  const forge = new GitCodeForge({ token: 't', fetchImpl: impl })
  await assert.rejects(() => forge.postInline(), NotEnabled)
  await assert.rejects(() => forge.postSummary(), NotEnabled)
  await assert.rejects(() => forge.setStatus(), NotEnabled)
})

test('没有令牌时给出明确错误，而不是发出匿名请求', () => {
  const saved = { token: process.env.GITCODE_TOKEN, config: process.env.GITCODE_CONFIG }
  delete process.env.GITCODE_TOKEN
  delete process.env.GITCODE_CONFIG
  try {
    assert.throws(() => new GitCodeForge(), /未提供 GitCode 令牌/)
  } finally {
    if (saved.token !== undefined) process.env.GITCODE_TOKEN = saved.token
    if (saved.config !== undefined) process.env.GITCODE_CONFIG = saved.config
  }
})
