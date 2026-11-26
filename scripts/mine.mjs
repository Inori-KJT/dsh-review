/**
 * 挖掘脚本：从仓库历史里生成评测候选用例，输出 JSON 与一份 Markdown 清单。
 *
 * 它只做挖掘，不跑评审——跑评审需要 DSH 会话，那是 eval 运行器的事。
 * 分开的理由：挖掘是纯 git，几秒完成；跑评审是分钟级。先看候选清单再决定跑哪些。
 *
 * 用法：
 *   node scripts/mine.mjs --repo /path/to/clone [--limit 400] [--out /tmp/cases.json]
 */
import { writeFileSync } from 'node:fs'

import { readCommitViews } from '../src/adapters/git-cli.ts'
import { mineCases, mineCleanCases } from '../src/app/eval.ts'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index]
  if (!token.startsWith('--')) continue
  const next = process.argv[index + 1]
  args.set(token.slice(2), next !== undefined && !next.startsWith('--') ? next : 'true')
  if (args.get(token.slice(2)) !== 'true') index += 1
}

const repo = args.get('repo')
if (!repo) {
  process.stderr.write('需要 --repo <本地克隆路径>\n')
  process.exit(2)
}
const limit = Number(args.get('limit') ?? 400)
const out = args.get('out') ?? '/root/zhaochi/eval-cases.json'

const commits = readCommitViews(repo, limit)
process.stdout.write(`[mine] 读到 ${commits.length} 个提交\n`)

const defects = mineCases(commits)
const clean = mineCleanCases(commits, { now: Date.now(), limit: 20 })
process.stdout.write(`[mine] 缺陷候选 ${defects.length} 个，干净候选 ${clean.length} 个\n`)

const payload = { at: new Date().toISOString(), repo, commits: commits.length, defects, clean }
writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8')
process.stdout.write(`[mine] 已写 ${out}\n`)

const lines = [
  '# 评测候选用例清单',
  '',
  `仓库 ${repo} · 扫描 ${commits.length} 个提交 · 生成时间 ${payload.at}`,
  '',
  `缺陷候选 ${defects.length} 个，干净候选 ${clean.length} 个。`,
  '**每一个缺陷候选都需要人工确认一次**，确认的是"这个修复确实修的是那个提交引入的问题"，',
  '而不是自己去想那个提交里有哪些问题。',
  '',
  '## 缺陷候选',
  '',
  '| id | 来源 | 引入提交 | base | 提示位置 | 需要确认 |',
  '| --- | --- | --- | --- | --- | --- |',
  ...defects.map(item => `| \`${item.id}\` | ${item.source} | \`${item.headSha.slice(0, 8)}\` | \`${(item.baseSha || '').slice(0, 8)}\` | ${item.hints.map(hint => `${hint.path}:${hint.line ?? '?'}`).join('<br>') || '（无）'} | ${item.needsConfirmation} |`),
  '',
  '## 干净候选',
  '',
  '| id | 提交 | 提示位置 | 说明 |',
  '| --- | --- | --- | --- |',
  ...clean.map(item => `| \`${item.id}\` | \`${item.headSha.slice(0, 8)}\` | ${item.hints.map(hint => `${hint.path}:${hint.line ?? '?'}`).join('<br>') || '（无）'} | ${item.evidence} |`),
  '',
]
const mdPath = out.replace(/\.json$/, '.md')
writeFileSync(mdPath, lines.join('\n'), 'utf8')
process.stdout.write(`[mine] 已写 ${mdPath}\n`)
