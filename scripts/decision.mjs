/**
 * 生成 T9 决策包：从状态库里读出运行、发现、反馈，算处置比例与门槛，输出一页 Markdown。
 *
 * 用法：
 *   node scripts/decision.mjs --db /path/to/dsh-review.sqlite --days 6 [--out /tmp/decision.md]
 */
import { writeFileSync } from 'node:fs'

import { SqliteStore } from '../src/adapters/sqlite-store.ts'
import { buildDecisionPackage, renderDecisionPackage } from '../src/app/decision.ts'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index]
  if (!token.startsWith('--')) continue
  const next = process.argv[index + 1]
  args.set(token.slice(2), next !== undefined && !next.startsWith('--') ? next : 'true')
  if (args.get(token.slice(2)) !== 'true') index += 1
}

const dbPath = args.get('db')
if (!dbPath) {
  process.stderr.write('需要 --db <sqlite 路径>\n')
  process.exit(2)
}
const days = Number(args.get('days') ?? 0)
const out = args.get('out') ?? '/root/zhaochi/t9-decision.md'

const store = new SqliteStore(dbPath)
const runs = await store.listRuns({ limit: 1000 })
const findings = []
const feedback = []
for (const run of runs) {
  const runFindings = await store.listFindings(run.id)
  findings.push(...runFindings)
  for (const finding of runFindings) {
    for (const item of await store.listFeedback(finding.id)) {
      feedback.push({
        findingId: finding.id,
        verdict: item.verdict,
        title: finding.title,
        severity: finding.severity,
        category: finding.category,
        path: finding.defectLocation.path,
        runId: run.id,
      })
    }
  }
}

const pkg = buildDecisionPackage({
  at: new Date().toISOString(),
  days,
  runs: runs.map(run => ({
    id: run.id,
    repo: run.repo,
    pr: run.pr,
    status: run.status,
    sessions: run.usage.sessions,
    turns: run.usage.turns,
    durationMs: run.usage.durationMs,
  })),
  findings: findings.map(finding => ({
    id: finding.id,
    runId: finding.runId,
    title: finding.title,
    severity: finding.severity,
    category: finding.category,
    path: finding.defectLocation.path,
    status: finding.status,
  })),
  feedback,
})

writeFileSync(out, renderDecisionPackage(pkg), 'utf8')
process.stdout.write(`[decision] ${runs.length} 次运行 / ${findings.length} 条发现 / ${feedback.length} 条处置 → ${out}\n`)
process.stdout.write(`[decision] 建议：${pkg.recommendation}\n`)
for (const reason of pkg.reasons) process.stdout.write(`[decision]   ${reason}\n`)
await store.close()
