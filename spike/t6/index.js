/**
 * T6 验证装置。四项验收，全部对着真实的 GitCode 仓库：
 *   1 对一个真实 PR 跑通 Standard，结果落库
 *   2 PR 新推一次后自动触发第 2 轮增量评审（round=2，since=上一轮 head）
 *   3 在 PR 下发一条评论，不触发任何运行
 *   4 同一个 head 重复轮询不重复建运行
 *
 * 第二与第三项用一层可控的 Forge 包装：真实的 PR 数据来自 GitCode，
 * 只是把 head 与评论列表换掉，以便在不向对方仓库推送的前提下验证触发逻辑。
 */
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { buildDeps, runOnce } from '../../src/app/cli.ts'
import { PollingTrigger } from '../../src/app/trigger.ts'

const PROBE = process.env.SPIKE_PROBE || '/root/zhaochi/t6-probe.log'
const started = Date.now()
const here = new URL(import.meta.url).pathname
const turnCounts = new Map()

function probe(message) {
  try { appendFileSync(PROBE, `${new Date().toISOString()} +${Date.now() - started}ms ${message}\n`) } catch {}
  try { process.stderr.write(`[t6] ${message}\n`) } catch {}
}

probe('module loaded')
export const name = 'dsh-review-t6-spike'
export const inject = ['sessionController', 'workspaceRegistry']

export function apply(ctx) {
  probe(`apply; SPIKE_RUN=${process.env.SPIKE_RUN ?? 'unset'}`)
  try {
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/start') return
      const id = String(session?.id ?? session?.header?.id ?? '')
      turnCounts.set(id, (turnCounts.get(id) ?? 0) + 1)
    })
  } catch (error) {
    probe(`turn counter failed: ${error?.message ?? error}`)
  }
  if (process.env.SPIKE_RUN !== '1') return
  Promise.resolve().then(() => run(ctx)).catch(error => probe(`run rejected: ${error?.stack ?? error}`))
}

/** 可控 Forge：真实数据来自 GitCode，head 与评论可覆盖。 */
class OverridableForge {
  constructor(inner) {
    this.inner = inner
    this.headOverride = undefined
    this.extraComments = []
    this.listCalls = 0
  }

  async listPulls(query) {
    this.listCalls += 1
    const pulls = await this.inner.listPulls(query)
    if (!this.headOverride) return pulls
    return pulls.map(pull => ({ ...pull, headSha: this.headOverride }))
  }

  async getPull(repo, pr) { return this.inner.getPull(repo, pr) }
  async listComments(repo, pr) {
    const base = await this.inner.listComments(repo, pr)
    return [...base, ...this.extraComments]
  }
  async readMergeable(repo, pr) { return this.inner.readMergeable(repo, pr) }
  async postInline() { throw new Error('NotEnabled') }
  async postSummary() { throw new Error('NotEnabled') }
  async setStatus() { throw new Error('NotEnabled') }
  async listReplies() { return [] }
}

async function run(ctx) {
  const out = process.env.SPIKE_OUT || '/root/zhaochi/t6-report.json'
  const repoPath = process.env.SPIKE_REPO_PATH || '/root/zhaochi/t6-work'
  const report = { at: new Date().toISOString(), checks: {}, errors: [] }
  const save = () => {
    try { mkdirSync(dirname(out), { recursive: true }) } catch {}
    try { writeFileSync(out, JSON.stringify(report, null, 2), 'utf8') } catch {}
  }
  save()

  const deps = buildDeps({
    statePath: process.env.SPIKE_STATE || '/root/zhaochi/t6-state.db',
    sessionHost: { sessionController: ctx.sessionController, workspaceRegistry: ctx.workspaceRegistry },
    repoPaths: {},
    maxConcurrent: 2,
  })
  const forge = new OverridableForge(deps.forge)

  try {
    // ---------- 找出一个真实开放 PR ----------
    const repo = process.env.SPIKE_REPO || 'TokensService/tokens-worktable'
    const pulls = await deps.forge.listPulls({ repo, state: 'open' })
    probe(`开放 PR ${pulls.length} 个: ${pulls.map(p => '#' + p.number).join(',')}`)
    report.checks.pulls = pulls.map(pull => ({ number: pull.number, headSha: pull.headSha.slice(0, 10), baseSha: pull.baseSha.slice(0, 10) }))
    if (pulls.length === 0) throw new Error('没有开放 PR，无法验收')
    const target = pulls[0]
    report.checks.target = { repo, pr: target.number, base: target.baseSha, head: target.headSha }
    save()

    // ---------- 检查 1：跑通 Standard 并落库 ----------
    probe(`开始 Standard 评审 #${target.number}`)
    const result = await runOnce(
      { ...deps, forge },
      { repo, pr: target.number, depth: 'standard', mode: 'record', wait: true },
      repoPath,
    )
    report.checks.standardRun = result
    const findings = result.runId ? await deps.store.listFindings(result.runId) : []
    const stages = result.runId ? await deps.store.listStages(result.runId) : []
    const events = result.runId ? await deps.store.listEvents(result.runId) : []
    report.checks.standardDetail = {
      status: result.status,
      findings: findings.length,
      findingTitles: findings.map(f => f.title).slice(0, 6),
      findingStatuses: findings.map(f => f.status),
      stages: stages.map(s => `${s.stage}:${s.status}`),
      eventCount: events.length,
      headSha: (await deps.store.getRun(result.runId))?.headSha.slice(0, 10),
    }
    save()
    probe(`Standard 结束 status=${result.status} 发现=${findings.length}`)

    // ---------- 检查 4：同 head 重复轮询不重复建运行 ----------
    const triggerSame = new PollingTrigger({
      forge,
      submit: request => deps.scheduler.submit(request),
      listRuns: () => deps.store.listRuns({ limit: 500 }),
      repoPathFor: () => repoPath,
      targets: [{ repo }],
    })
    const sameOutcome = await triggerSame.pollOnce()
    report.checks.pollUnchanged = { submitted: sameOutcome.submitted.length, unchanged: sameOutcome.unchanged, blocked: sameOutcome.blocked.length }
    save()
    probe(`同 head 轮询: submitted=${sameOutcome.submitted.length} unchanged=${sameOutcome.unchanged}`)

    // ---------- 检查 2：模拟新推一次，触发第 2 轮增量 ----------
    // 用 base sha 充当"新 head"：它是真实存在的提交，且与上一轮 head 不同。
    forge.headOverride = target.baseSha
    const triggerNew = new PollingTrigger({
      forge,
      submit: request => deps.scheduler.submit(request),
      listRuns: () => deps.store.listRuns({ limit: 500 }),
      repoPathFor: () => repoPath,
      targets: [{ repo }],
      depth: 'quick',
    })
    const newOutcome = await triggerNew.pollOnce()
    report.checks.pollNewHead = {
      submitted: newOutcome.submitted.map(item => ({ pr: item.pr, round: item.round, since: item.since?.slice(0, 10), runId: item.runId })),
      unchanged: newOutcome.unchanged,
    }
    save()
    probe(`新 head 轮询: ${JSON.stringify(report.checks.pollNewHead.submitted)}`)

    // ---------- 检查 3：评论不触发运行 ----------
    forge.headOverride = undefined
    forge.extraComments.push({ id: 'synthetic-1', author: 'someone', body: '请评审一下这个 PR', at: new Date().toISOString() })
    const runsBefore = (await deps.store.listRuns({ limit: 500 })).length
    const triggerComments = new PollingTrigger({
      forge,
      submit: request => deps.scheduler.submit(request),
      listRuns: () => deps.store.listRuns({ limit: 500 }),
      repoPathFor: () => repoPath,
      targets: [{ repo }],
    })
    const commentOutcome = await triggerComments.pollOnce()
    const runsAfter = (await deps.store.listRuns({ limit: 500 })).length
    report.checks.commentNoRun = {
      submitted: commentOutcome.submitted.length,
      runsBefore,
      runsAfter,
      note: 'head 未变，评论只应写 feedback；触发器从不读评论做触发',
    }
    save()
    probe(`评论轮询: submitted=${commentOutcome.submitted.length} runs ${runsBefore} -> ${runsAfter}`)

    report.checks.runTotal = runsAfter
  } catch (error) {
    report.errors.push(String(error?.stack ?? error))
    probe(`run error: ${error?.message ?? error}`)
  } finally {
    save()
    await deps.close()
    probe(`report at ${out}`)
  }
}
