/**
 * 服务端渲染的视图。纯函数：给数据，出 HTML 字符串。
 *
 * 这一层刻意不用框架、不用 WebSocket：每 5 秒整页刷新足够看出进度，
 * 而整页刷新意味着任何浏览器、任何禁用脚本的环境都能用。
 * 面板上看到的内容形态就是将来评论的形态，所以发现正文按"位置 + 一句话结论 +
 * 触发条件 + 错误结果"排，与 publish 阶段生成的摘要保持一致。
 */
import type { Finding, Run, StageExec, Vote } from '../core/model.ts'

export interface RunRow {
  run: Run
  findingCount: number
  heldCount: number
}

export interface RunsPageData {
  waiting: RunRow[]
  running: RunRow[]
  finished: RunRow[]
  repos: string[]
  now: string
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STYLE = `
:root { color-scheme: light dark }
body { font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; background: #fafafa; color: #222 }
h1 { font-size: 18px; margin: 0 0 4px }
h2 { font-size: 15px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #ddd }
.meta { color: #666; font-size: 12px }
table { border-collapse: collapse; width: 100%; background: #fff }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; vertical-align: top }
th { font-weight: 600; background: #f4f4f4; font-size: 12px }
.tag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; background: #e8e8e8 }
.tag.wait { background: #ffe9c7 }
.tag.run { background: #cfe8ff }
.tag.done { background: #d8f0d8 }
.tag.held { background: #ffd9d9 }
.loc { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: #444 }
.why { color: #555; font-size: 12px }
button { font: inherit; padding: 2px 8px; margin-right: 4px; cursor: pointer }
form { display: inline }
.empty { color: #888; padding: 12px 0 }
`

const REFRESH = '<meta http-equiv="refresh" content="5">'

/** 运行列表页。 */
export function renderRunsPage(data: RunsPageData): string {
  return page('dsh-review 面板', `
<h1>dsh-review</h1>
<div class="meta">最近刷新 ${escapeHtml(data.now)} · 每 5 秒自动刷新 · 监听 127.0.0.1</div>

<h2>等你处理</h2>
${runsTable(data.waiting, 'wait')}

<h2>进行中</h2>
${runsTable(data.running, 'run')}

<h2>已完成</h2>
${runsTable(data.finished, 'done')}

<h2>手动发起评审</h2>
<form method="post" action="/review/api/runs-form">
  <label>仓库 <input name="repo" placeholder="owner/name" size="34" value="${escapeHtml(data.repos[0] ?? '')}"></label>
  <label>PR <input name="pr" size="6" placeholder="312"></label>
  <label>档位
    <select name="depth">
      <option value="quick">quick</option>
      <option value="standard" selected>standard</option>
    </select>
  </label>
  <button type="submit">发起</button>
</form>
<div class="meta">发起后回到本页，进度在"进行中"一栏可见。</div>
`)
}

function runsTable(rows: RunRow[], kind: 'wait' | 'run' | 'done'): string {
  if (rows.length === 0) return '<div class="empty">（无）</div>'
  const body = rows.map(row => {
    const run = row.run
    return `<tr>
  <td><a href="/review/ui/run?id=${encodeURIComponent(run.id)}">${escapeHtml(run.repo)} #${run.pr}</a></td>
  <td><span class="tag ${kind}">${escapeHtml(run.status)}</span></td>
  <td>${run.round}</td>
  <td>${escapeHtml(run.depth)}</td>
  <td>${escapeHtml(run.headSha.slice(0, 10))}</td>
  <td>${row.findingCount}${row.heldCount > 0 ? ` <span class="tag held">${row.heldCount} 待确认</span>` : ''}</td>
  <td class="meta">${escapeHtml(run.updatedAt.replace('T', ' ').slice(0, 19))}</td>
</tr>`
  }).join('\n')
  return `<table>
<thead><tr><th>PR</th><th>状态</th><th>轮次</th><th>档位</th><th>head</th><th>发现</th><th>更新</th></tr></thead>
<tbody>${body}</tbody></table>`
}

export interface StageRow extends StageExec {
  sessionCount: number
}

export interface RunDetailData {
  run: Run
  stages: StageRow[]
  findings: Finding[]
  votesByFinding: Record<string, Vote[]>
  feedbackByFinding: Record<string, string[]>
  notes: string[]
  now: string
}

/** 运行详情页：阶段导轨、发现表、处置按钮。 */
export function renderRunDetail(data: RunDetailData): string {
  const { run } = data
  const findings = data.findings.length === 0
    ? '<div class="empty">本次没有发现。</div>'
    : `<table>
<thead><tr><th>位置</th><th>结论</th><th>触发条件 / 错误结果</th><th>票数</th><th>状态</th><th>处置</th></tr></thead>
<tbody>${data.findings.map(finding => findingRow(finding, data)).join('\n')}</tbody></table>`

  return page(`${run.repo} #${run.pr}`, `
<h1>${escapeHtml(run.repo)} #${run.pr} · 第 ${run.round} 轮</h1>
<div class="meta">
  状态 ${escapeHtml(run.status)} · 档位 ${escapeHtml(run.depth)} · 模式 ${escapeHtml(run.mode)} ·
  base ${escapeHtml(run.baseSha.slice(0, 10))} · head ${escapeHtml(run.headSha.slice(0, 10))}
  ${run.since ? ` · since ${escapeHtml(run.since.slice(0, 10))}` : ''} ·
  会话 ${run.usage.sessions} · 耗时 ${Math.round(run.usage.durationMs / 1000)} 秒
</div>
<div class="meta"><a href="/review/ui">返回列表</a></div>

<h2>阶段导轨</h2>
${stagesRail(data.stages)}

${data.notes.length > 0 ? `<h2>运行说明</h2><ul>${data.notes.map(note => `<li class="why">${escapeHtml(note)}</li>`).join('')}</ul>` : ''}

<h2>发现</h2>
${findings}

<h2>操作</h2>
${run.status === 'running' || run.status === 'queued'
  ? `<form method="post" action="/review/api/runs/${encodeURIComponent(run.id)}/cancel-form"><button type="submit">取消本次运行</button></form>`
  : '<span class="meta">该运行已结束。</span>'}
`)
}

function stagesRail(stages: StageRow[]): string {
  if (stages.length === 0) return '<div class="empty">（还没有阶段记录）</div>'
  const items = stages.map(stage => {
    const ms = stage.endedAt && stage.startedAt
      ? Math.max(0, new Date(stage.endedAt).getTime() - new Date(stage.startedAt).getTime())
      : 0
    return `<tr>
  <td>${escapeHtml(stage.stage)}</td>
  <td><span class="tag">${escapeHtml(stage.status)}</span></td>
  <td>${stage.attempt}</td>
  <td>${stage.sessionCount}</td>
  <td>${ms} ms</td>
</tr>`
  }).join('\n')
  return `<table>
<thead><tr><th>阶段</th><th>状态</th><th>尝试</th><th>会话</th><th>耗时</th></tr></thead>
<tbody>${items}</tbody></table>`
}

function findingRow(finding: Finding, data: RunDetailData): string {
  const votes = data.votesByFinding[finding.id] ?? []
  const stands = votes.filter(vote => vote.verdict === 'stands').length
  const rejected = votes.filter(vote => vote.verdict === 'rejected').length
  const feedback = data.feedbackByFinding[finding.id] ?? []
  const id = encodeURIComponent(finding.id)
  const actions = [
    `<form method="post" action="/review/api/findings/${id}/feedback-form"><input type="hidden" name="verdict" value="valid"><button type="submit">成立</button></form>`,
    `<form method="post" action="/review/api/findings/${id}/feedback-form"><input type="hidden" name="verdict" value="false-positive"><button type="submit">误报</button></form>`,
    `<form method="post" action="/review/api/findings/${id}/feedback-form"><input type="hidden" name="verdict" value="intended"><button type="submit">有意为之</button></form>`,
    `<form method="post" action="/review/api/findings/${id}/feedback-form"><input type="hidden" name="verdict" value="unimportant"><button type="submit">不重要</button></form>`,
  ]
  if (finding.status === 'held') {
    actions.push(`<form method="post" action="/review/api/findings/${id}/release-form"><button type="submit">放行</button></form>`)
  }
  return `<tr>
  <td class="loc">${escapeHtml(finding.defectLocation.path)}:${finding.defectLocation.startLine}</td>
  <td>${escapeHtml(finding.title)}<br><span class="tag">${escapeHtml(finding.severity)}</span> <span class="tag">${escapeHtml(finding.category)}</span></td>
  <td class="why">触发：${escapeHtml(finding.trigger)}<br>结果：${escapeHtml(finding.outcome)}</td>
  <td>${stands} 成 / ${rejected} 否${votes.some(vote => vote.reproducesOnBase === 'yes') ? '<br><span class="tag">base 上复现</span>' : ''}</td>
  <td><span class="tag${finding.status === 'held' ? ' held' : ''}">${escapeHtml(finding.status)}</span>${feedback.length ? `<br><span class="meta">${escapeHtml(feedback.join(' / '))}</span>` : ''}</td>
  <td>${actions.join('')}</td>
</tr>`
}

/** 极简错误页。 */
export function renderMessage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p class="meta"><a href="/review/ui">返回列表</a></p>`)
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${REFRESH}
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`
}
