/**
 * T8 评测运行器。
 *
 * 读 cases.json，对每个用例跑一次真实评审，算四个指标，写出基线报告。
 * 与挖掘脚本分开：挖掘是纯 git，几秒；这里是分钟级，需要 DSH 会话。
 */
import { appendFileSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { buildDeps, runOnce } from '../../src/app/cli.ts'
// 注意：本文件是 .js，Node 不对它做类型剥离，因此 import 里不能写 `type X` 修饰。
import { isHit, renderEvalReport, summarize } from '../../src/app/eval.ts'

const PROBE = process.env.SPIKE_PROBE || '/root/zhaochi/t8-probe.log'
const started = Date.now()
const turnCounts = new Map()

function probe(message) {
  try { appendFileSync(PROBE, `${new Date().toISOString()} +${Date.now() - started}ms ${message}\n`) } catch {}
  try { process.stderr.write(`[t8] ${message}\n`) } catch {}
}

probe('module loaded')
export const name = 'dsh-review-t8-spike'
export const inject = ['sessionController', 'workspaceRegistry']

export function apply(ctx) {
  probe(`apply; SPIKE_RUN=${process.env.SPIKE_RUN ?? 'unset'}`)
  try {
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/start') return
      const id = String(session?.id ?? session?.header?.id ?? '')
      turnCounts.set(id, (turnCounts.get(id) ?? 0) + 1)
    })
  } catch (error) { probe(`turn counter failed: ${error?.message ?? error}`) }
  if (process.env.SPIKE_RUN !== '1') return
  Promise.resolve().then(() => run(ctx)).catch(error => probe(`run rejected: ${error?.stack ?? error}`))
}

async function run(ctx) {
  const out = process.env.SPIKE_OUT || '/root/zhaochi/t8-report.md'
  const casesPath = process.env.SPIKE_CASES || '/root/zhaochi/t8-cases/cases.json'
  const depth = process.env.SPIKE_DEPTH || 'standard'
  const report = { at: new Date().toISOString(), cases: [], errors: [] }
  const save = () => {
    try { mkdirSync(dirname(out), { recursive: true }) } catch {}
    try { writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify(report, null, 2), 'utf8') } catch {}
  }

  const payload = JSON.parse(readFileSync(casesPath, 'utf8'))
  const all = [...(payload.defects ?? []), ...(payload.clean ?? [])]
  const cases = all.map(item => ({
    id: item.id,
    source: item.source,
    headSha: item.headSha,
    baseSha: item.baseSha,
    hints: item.hints ?? [],
    evidence: item.id,
    needsConfirmation: '',
    repoPath: item.repoPath,
  }))
  probe(`用例 ${cases.length} 个，档位 ${depth}`)

  const deps = buildDeps({
    statePath: process.env.SPIKE_STATE || '/root/zhaochi/t8-state.db',
    sessionHost: { sessionController: ctx.sessionController, workspaceRegistry: ctx.workspaceRegistry },
    repoPaths: {},
    maxConcurrent: 1,
    turnCounter: sessionId => turnCounts.get(sessionId) ?? 0,
    // 评测跑本地仓库，用不到平台；传空实现，免得为了跑本地评测先准备令牌。
    forge: {
      async listPulls() { return [] },
      async getPull() { return undefined },
      async listComments() { return [] },
      async readMergeable() { return { mergeable: true, conflictPassed: true } },
      async postInline() {}, async postSummary() {}, async setStatus() {},
      async listReplies() { return [] },
    },
  })

  const results = []
  try {
    for (const item of cases) {
      probe(`--- ${item.id} ---`)
      const outcome = await runOnce(
        deps,
        { repo: 'eval/' + item.id, base: item.baseSha, head: item.headSha, depth, mode: 'record', wait: true },
        item.repoPath,
      )
      const run = outcome.runId ? await deps.store.getRun(outcome.runId) : undefined
      const findings = outcome.runId ? await deps.store.listFindings(outcome.runId) : []
      const hits = findings.filter(finding => isHit(finding, item.hints)).length
      const result = {
        caseId: item.id,
        source: item.source,
        runId: outcome.runId,
        status: outcome.status ?? 'unknown',
        findingCount: findings.length,
        importantCount: findings.filter(finding => finding.severity === 'important').length,
        hits,
        hintCount: item.hints.length,
        sessions: run?.usage.sessions ?? 0,
        turns: run?.usage.turns ?? 0,
        durationMs: run?.usage.durationMs ?? 0,
        titles: findings.map(finding => finding.title),
      }
      results.push(result)
      report.cases.push(result)
      save()
      probe(`${item.id}: status=${result.status} 发现=${result.findingCount} 命中=${hits}/${result.hintCount} 会话=${result.sessions} 回合=${result.turns} 耗时=${Math.round(result.durationMs / 1000)}s`)
    }

    const summary = summarize(results)
    const markdown = renderEvalReport({
      cases,
      results,
      summary,
      configRevision: 1,
      at: new Date().toISOString(),
    }) + [
      '',
      '## 实测逐用例详情',
      '',
      ...results.map(result => `### ${result.caseId}（${result.source}）\n\n状态 ${result.status} · 发现 ${result.findingCount} 条 · Important ${result.importantCount} 条 · 命中 ${result.hits}/${result.hintCount} · 会话 ${result.sessions} · 回合 ${result.turns} · 耗时 ${Math.round(result.durationMs / 1000)} 秒\n\n${result.titles.length ? result.titles.map(title => `- ${title}`).join('\n') : '（本次没有发现）'}`),
      '',
    ].join('\n')
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, markdown, 'utf8')
    report.summary = summary
    save()
    probe(`基线报告已写 ${out}`)
  } catch (error) {
    report.errors.push(String(error?.stack ?? error))
    probe(`run error: ${error?.message ?? error}`)
    save()
  } finally {
    await deps.close()
  }
}
