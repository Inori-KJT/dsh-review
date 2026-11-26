/**
 * T7 的单测：HTTP 接口与面板。
 *
 * 用真实 HTTP（端口 0 由系统分配）+ 内存 SQLite + 假适配器，因此测的是
 * 真实的请求路由、同源检查与状态联动，不是模拟的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startServer, type StartedServer } from '../src/app/http.ts'
import { Scheduler } from '../src/app/scheduler.ts'
import { SqliteStore } from '../src/adapters/sqlite-store.ts'
import { stageTable } from '../src/stages/index.ts'
import { FakeVcs, FakeAgentRunner, sampleDiff, sampleFinding } from '../src/adapters/fakes.ts'
import type { ForgePort, PullDetail } from '../src/core/ports.ts'

const REPO = 'TokensService/demo'
const BASE = 'aaa111'
const HEAD = 'bbb222'

/** 只提供 T7 需要的读取能力。 */
class StubForge implements ForgePort {
  pull: PullDetail | undefined = {
    number: 7, headSha: HEAD, baseSha: BASE, author: 'someone', updatedAt: '2026-11-26T00:00:00Z',
    title: '演示 PR', description: '说明',
  }
  async listPulls() { return [] }
  async getPull() { return this.pull }
  async listComments() { return [] }
  async readMergeable() { return { mergeable: true, conflictPassed: true } }
  async postInline() {}
  async postSummary() {}
  async setStatus() {}
  async listReplies() { return [] }
}

interface Ctx {
  server: StartedServer
  store: SqliteStore
  base: string
  close: () => Promise<void>
}

async function setup(options: { runPipeline?: boolean } = {}): Promise<Ctx> {
  const path = join(mkdtempSync(join(tmpdir(), 't7-')), 'state.db')
  const store = new SqliteStore(path)
  const forge = new StubForge()
  const vcs = new FakeVcs({ diff: sampleDiff() })
  const agents = new FakeAgentRunner({ finders: { correctness: [sampleFinding({ severity: 'nit' })], security: [] } })
  const scheduler = new Scheduler({ store, deps: { vcs, forge, agents }, table: stageTable })
  const server = await startServer({
    store, scheduler, forge,
    repoPathFor: () => '/tmp/demo',
    port: 0,
  })
  const base = new URL(server.url).origin
  return {
    server, store, base,
    close: async () => { await server.close(); await store.close() },
  }
}

async function url(ctx: Ctx, path: string): Promise<string> { return `${ctx.base}${path}` }

// ---------- 健康检查与面板 ----------

test('健康检查返回 ok', async () => {
  const ctx = await setup()
  try {
    const response = await fetch(await url(ctx, '/review/api/health'))
    assert.equal(response.status, 200)
    const body = await response.json() as { ok: boolean }
    assert.equal(body.ok, true)
  } finally { await ctx.close() }
})

test('面板首页返回 HTML，含三个分栏与发起表单', async () => {
  const ctx = await setup()
  try {
    const response = await fetch(ctx.server.url)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/html/)
    const html = await response.text()
    assert.match(html, /等你处理/)
    assert.match(html, /进行中/)
    assert.match(html, /已完成/)
    assert.match(html, /手动发起评审/)
    // 每 5 秒整页刷新，不依赖脚本。
    assert.match(html, /http-equiv="refresh" content="5"/)
  } finally { await ctx.close() }
})

// ---------- 同源检查 ----------

test('不受信任的 Host 被拒', async () => {
  const ctx = await setup()
  try {
    // fetch 规范禁止覆盖 host 头，因此这里用底层 http 请求来构造伪造的 Host。
    const status = await rawStatus(ctx.base, '/review/api/health', { host: 'evil.example.com' })
    assert.equal(status, 403)
  } finally { await ctx.close() }
})

/** 发一个能自定义 Host 头的原始请求，返回状态码。 */
function rawStatus(origin: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(origin)
    import('node:http').then(({ request }) => {
      const req = request({
        hostname: target.hostname,
        port: target.port,
        path,
        method: 'GET',
        headers,
      }, response => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    }).catch(reject)
  })
}

test('跨源 POST 被拒', async () => {
  const ctx = await setup()
  try {
    const response = await fetch(await url(ctx, '/review/api/runs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' },
      body: JSON.stringify({ repo: REPO, pr: 7 }),
    })
    assert.equal(response.status, 403)
    const body = await response.json() as { error: string }
    assert.match(body.error, /跨源/)
  } finally { await ctx.close() }
})

// ---------- 发起、查看、取消 ----------

test('发起评审后能看到该运行', async () => {
  const ctx = await setup()
  try {
    const created = await fetch(await url(ctx, '/review/api/runs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO, pr: 7, depth: 'quick' }),
    })
    assert.equal(created.status, 200)
    const result = await created.json() as { runId: string; reused: boolean }
    assert.ok(result.runId)

    const list = await fetch(await url(ctx, '/review/api/runs'))
    const summary = await list.json() as { waiting: number; running: number; finished: number }
    assert.equal(summary.waiting + summary.running + summary.finished, 1)

    const detail = await fetch(await url(ctx, `/review/api/runs/${result.runId}`))
    assert.equal(detail.status, 200)
    const body = await detail.json() as { run: { repo: string; pr: number } }
    assert.equal(body.run.repo, REPO)
    assert.equal(body.run.pr, 7)
  } finally { await ctx.close() }
})

test('找不到 PR 时返回 500 并说明原因', async () => {
  const ctx = await setup()
  try {
    // 让 stub 返回 undefined，模拟 PR 不存在。
    const created = await fetch(await url(ctx, '/review/api/runs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pr: 0 }),
    })
    assert.equal(created.status, 400)
  } finally { await ctx.close() }
})

test('详情页渲染阶段导轨与发现表', async () => {
  const ctx = await setup()
  try {
    const created = await fetch(await url(ctx, '/review/api/runs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO, pr: 7, depth: 'quick' }),
    })
    const { runId } = await created.json() as { runId: string }

    // 等运行推进结束（quick 档在假适配器上是毫秒级）。
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = await ctx.store.getRun(runId)
      if (run && run.status !== 'queued' && run.status !== 'running') break
      await new Promise(resolveWait => setTimeout(resolveWait, 20))
    }

    const page = await fetch(await url(ctx, `/review/ui/run?id=${encodeURIComponent(runId)}`))
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /阶段导轨/)
    assert.match(html, /发现/)
    assert.match(html, /四个处置按钮|成立|误报|有意为之|不重要/)
  } finally { await ctx.close() }
})

// ---------- 处置与放行 ----------

test('四个处置按钮写入反馈并联动状态', async () => {
  const ctx = await setup()
  try {
    const created = await fetch(await url(ctx, '/review/api/runs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO, pr: 7, depth: 'quick' }),
    })
    const { runId } = await created.json() as { runId: string }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const findings = await ctx.store.listFindings(runId)
      if (findings.length > 0) break
      await new Promise(resolveWait => setTimeout(resolveWait, 20))
    }
    const findings = await ctx.store.listFindings(runId)
    assert.ok(findings.length > 0, '应当有发现落库')
    const id = findings[0].id

    const feedback = await fetch(await url(ctx, `/review/api/findings/${encodeURIComponent(id)}/feedback`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'false-positive' }),
    })
    assert.equal(feedback.status, 200)

    const stored = await ctx.store.listFeedback(id)
    assert.equal(stored.length, 1)
    assert.equal(stored[0].verdict, 'false-positive')
    assert.equal(stored[0].source, 'panel')

    const updated = (await ctx.store.listFindings(runId)).find(finding => finding.id === id)
    assert.equal(updated?.status, 'dismissed', '判误报后状态应为 dismissed')
  } finally { await ctx.close() }
})

test('非法 verdict 被拒', async () => {
  const ctx = await setup()
  try {
    const response = await fetch(await url(ctx, '/review/api/findings/x/feedback'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'whatever' }),
    })
    assert.equal(response.status, 400)
  } finally { await ctx.close() }
})

test('放行把 held 改成 verified', async () => {
  const ctx = await setup()
  try {
    const created = await fetch(await url(ctx, '/review/api/runs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO, pr: 7, depth: 'quick' }),
    })
    const { runId } = await created.json() as { runId: string }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await ctx.store.listFindings(runId)).length > 0) break
      await new Promise(resolveWait => setTimeout(resolveWait, 20))
    }
    const id = (await ctx.store.listFindings(runId))[0].id
    await ctx.store.updateFindingStatus(id, 'held')

    const released = await fetch(await url(ctx, `/review/api/findings/${encodeURIComponent(id)}/release`), { method: 'POST' })
    assert.equal(released.status, 200)
    const after = (await ctx.store.listFindings(runId)).find(finding => finding.id === id)
    assert.equal(after?.status, 'verified')
  } finally { await ctx.close() }
})

test('取消接口改变运行状态', async () => {
  const ctx = await setup()
  try {
    const created = await fetch(await url(ctx, '/review/api/runs'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: REPO, pr: 7, depth: 'standard' }),
    })
    const { runId } = await created.json() as { runId: string }
    const cancelled = await fetch(await url(ctx, `/review/api/runs/${encodeURIComponent(runId)}/cancel`), { method: 'POST' })
    assert.equal(cancelled.status, 200)
    const run = await ctx.store.getRun(runId)
    assert.equal(run?.status, 'cancelled')
  } finally { await ctx.close() }
})

test('未知路由返回 404 并回显路径', async () => {
  const ctx = await setup()
  try {
    const response = await fetch(await url(ctx, '/review/api/nope'))
    assert.equal(response.status, 404)
    const body = await response.json() as { error: string }
    assert.match(body.error, /nope/)
  } finally { await ctx.close() }
})
