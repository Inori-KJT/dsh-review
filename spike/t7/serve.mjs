/**
 * T7 现场验证：用 T6 落库的真实运行启动面板，不依赖 DSH。
 *
 * 面板本身只读数据库，所以这里不需要真实会话；它验证的是"服务能起来、
 * 页面能渲染真实数据、处置按钮能写库"。发起新评审那一条由 tests/http.test.ts 覆盖。
 */
import { SqliteStore } from '../../src/adapters/sqlite-store.ts'
import { Scheduler } from '../../src/app/scheduler.ts'
import { stageTable } from '../../src/stages/index.ts'
import { FakeVcs, FakeAgentRunner, sampleDiff } from '../../src/adapters/fakes.ts'
import { startServer } from '../../src/app/http.ts'

const statePath = process.env.SPIKE_STATE || '/root/zhaochi/t6-state.db'
const port = Number(process.env.SPIKE_PORT || 3087)

const store = new SqliteStore(statePath)
const forge = {
  async listPulls() { return [] },
  async getPull() { return undefined },
  async listComments() { return [] },
  async readMergeable() { return { mergeable: true, conflictPassed: true } },
  async postInline() {}, async postSummary() {}, async setStatus() {},
  async listReplies() { return [] },
}
const scheduler = new Scheduler({
  store,
  deps: { vcs: new FakeVcs({ diff: sampleDiff() }), forge, agents: new FakeAgentRunner() },
  table: stageTable,
})

const runs = await store.listRuns({ limit: 20 })
process.stdout.write(`[t7] 库里有 ${runs.length} 次运行\n`)
for (const run of runs) {
  const findings = await store.listFindings(run.id)
  process.stdout.write(`[t7]   ${run.id} ${run.repo}#${run.pr} status=${run.status} 发现=${findings.length}\n`)
}

const server = await startServer({ store, scheduler, forge, repoPathFor: () => '/tmp/none', port })
process.stdout.write(`[t7] 面板: ${server.url}\n`)
process.stdout.write('[t7] ready\n')
