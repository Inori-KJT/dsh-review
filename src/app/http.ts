/**
 * HTTP 接口与面板服务。
 *
 * 两条硬规则：
 *   1 只监听 127.0.0.1，因此本机以外不可达。
 *   2 所有写请求做同源检查：Host 必须是监听地址之一，POST 若带 Origin 必须与 Host 一致。
 *      这样即使有人在本机别的端口起了页面，也无法用表单或脚本改状态。
 *
 * 路由分两类：/review/api/* 返回 JSON，供脚本与将来的 CLI 用；
 * /review/*-form 与 /review/ui 返回 HTML，供浏览器直接用。两者的业务逻辑是同一份。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

import type { Depth, Finding, PublishMode, Run } from '../core/model.ts'
import type { ForgePort, StorePort } from '../core/ports.ts'
import type { Scheduler } from './scheduler.ts'
import {
  renderMessage, renderRunDetail, renderRunsPage,
  type RunDetailData, type RunRow, type StageRow,
} from './views.ts'

export interface HttpDeps {
  store: StorePort
  scheduler: Scheduler
  /** 取 PR 的 base/head 用。 */
  forge: ForgePort
  /** 地图：仓库 → 本地克隆路径。 */
  repoPathFor: (repo: string) => string
  /** 允许的 Host，默认只允许 127.0.0.1 与本机 hostname。 */
  allowedHosts?: string[]
  now?: () => number
}

export interface HttpServerOptions extends HttpDeps {
  port?: number
  host?: string
}

export interface StartedServer {
  url: string
  close: () => Promise<void>
}

/** 起一个只看本机的服务。port 传 0 时由系统分配，实际端口从 address() 读回。 */
export async function startServer(options: HttpServerOptions): Promise<StartedServer> {
  const host = options.host ?? '127.0.0.1'
  const requested = options.port ?? 3087
  let allowedHosts: string[] = options.allowedHosts ?? []
  let actualPort = requested

  const handler = makeHandler({
    ...options,
    get allowedHosts() { return allowedHosts.length > 0 ? allowedHosts : [`${host}:${actualPort}`] },
  } as unknown as HttpDeps & { allowedHosts: string[] })

  const server = createServer((request, response) => {
    handler(request, response).catch(error => {
      respondJson(response, 500, { error: String(error?.message ?? error) })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(requested, host, () => {
      const address = server.address()
      if (address && typeof address === 'object') actualPort = address.port
      if (allowedHosts.length === 0) allowedHosts = [`${host}:${actualPort}`, `localhost:${actualPort}`]
      resolve()
    })
  })

  return {
    url: `http://${host}:${actualPort}/review/ui`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

export function makeHandler(deps: HttpDeps & { allowedHosts: string[] }) {
  const now = deps.now ?? (() => Date.now())

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
    const path = url.pathname

    // 同源检查：Host 必须在允许名单里。
    const hostHeader = request.headers.host ?? ''
    if (!deps.allowedHosts.includes(hostHeader)) {
      respondJson(response, 403, { error: `不受信任的 Host: ${hostHeader}` })
      return
    }
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = request.headers.origin
      if (origin && !deps.allowedHosts.some(allowed => origin === `http://${allowed}`)) {
        respondJson(response, 403, { error: `跨源请求被拒: ${origin}` })
        return
      }
    }

    try {
      // ---------- 健康检查 ----------
      if (method === 'GET' && path === '/review/api/health') {
        respondJson(response, 200, { ok: true, at: new Date(now()).toISOString() })
        return
      }

      // ---------- 面板首页 ----------
      if (method === 'GET' && path === '/review/ui') {
        respondHtml(response, 200, renderRunsPage(await runsPageData(deps, now)))
        return
      }

      // ---------- 运行详情页 ----------
      if (method === 'GET' && path === '/review/ui/run') {
        const id = url.searchParams.get('id') ?? ''
        const detail = await runDetail(deps, id)
        if (!detail) {
          respondHtml(response, 404, renderMessage('找不到该运行', id))
          return
        }
        respondHtml(response, 200, renderRunDetail(detail))
        return
      }

      // ---------- JSON 接口 ----------
      if (method === 'GET' && path === '/review/api/runs') {
        const data = await runsPageData(deps, now)
        respondJson(response, 200, { waiting: data.waiting.length, running: data.running.length, finished: data.finished.length })
        return
      }

      const runIdMatch = /^\/review\/api\/runs\/([^/]+)$/.exec(path)
      if (method === 'GET' && runIdMatch) {
        const detail = await runDetail(deps, decodeURIComponent(runIdMatch[1]))
        if (!detail) { respondJson(response, 404, { error: 'not found' }); return }
        respondJson(response, 200, {
          run: detail.run,
          stages: detail.stages.map(stage => ({ stage: stage.stage, status: stage.status, attempt: stage.attempt, sessions: stage.sessionCount })),
          findings: detail.findings.map(finding => ({
            id: finding.id, path: finding.defectLocation.path, line: finding.defectLocation.startLine,
            title: finding.title, severity: finding.severity, status: finding.status,
            votes: (detail.votesByFinding[finding.id] ?? []).length,
          })),
          notes: detail.notes,
        })
        return
      }

      // ---------- 发起评审 ----------
      if (method === 'POST' && (path === '/review/api/runs' || path === '/review/api/runs-form')) {
        const body = path.endsWith('-form') ? parseForm(await readBody(request)) : parseJson(await readBody(request))
        const repo = String(body.repo ?? '')
        const pr = Number(body.pr ?? 0)
        const depth = String(body.depth ?? 'standard') as Depth
        const mode = 'record' as PublishMode
        if (!repo || !Number.isFinite(pr) || pr <= 0) {
          respondJson(response, 400, { error: '需要 repo 与 pr' })
          return
        }
        const result = await createRun(deps, { repo, pr, depth, mode })
        if (path.endsWith('-form')) { redirect(response, '/review/ui'); return }
        respondJson(response, 200, result)
        return
      }

      // ---------- 取消 ----------
      const cancelMatch = /^\/review\/api\/runs\/([^/]+)\/cancel(-form)?$/.exec(path)
      if (method === 'POST' && cancelMatch) {
        const id = decodeURIComponent(cancelMatch[1])
        await deps.scheduler.cancel(id)
        if (cancelMatch[2]) { redirect(response, `/review/ui/run?id=${encodeURIComponent(id)}`); return }
        respondJson(response, 200, { ok: true })
        return
      }

      // ---------- 发现的放行与扣下 ----------
      const releaseMatch = /^\/review\/api\/findings\/([^/]+)\/release(-form)?$/.exec(path)
      if (method === 'POST' && releaseMatch) {
        const id = decodeURIComponent(releaseMatch[1])
        await deps.store.updateFindingStatus(id, 'verified')
        if (releaseMatch[2]) { redirect(response, '/review/ui'); return }
        respondJson(response, 200, { ok: true, status: 'verified' })
        return
      }

      // ---------- 四个处置按钮 ----------
      const feedbackMatch = /^\/review\/api\/findings\/([^/]+)\/feedback(-form)?$/.exec(path)
      if (method === 'POST' && feedbackMatch) {
        const id = decodeURIComponent(feedbackMatch[1])
        const body = feedbackMatch[2] ? parseForm(await readBody(request)) : parseJson(await readBody(request))
        const verdict = String(body.verdict ?? '')
        const allowed = ['valid', 'false-positive', 'intended', 'unimportant']
        if (!allowed.includes(verdict)) {
          respondJson(response, 400, { error: `verdict 必须是 ${allowed.join('/')}` })
          return
        }
        await deps.store.insertFeedback({
          findingId: id,
          source: 'panel',
          verdict: verdict as 'valid' | 'false-positive' | 'intended' | 'unimportant',
          note: body.note ? String(body.note) : undefined,
          by: 'panel-user',
          actorType: 'human',
          at: new Date(now()).toISOString(),
        })
        // 处置与状态联动：误报与不重要把发现关掉，成立保持已核实。
        const status: Finding['status'] = verdict === 'valid' ? 'verified' : 'dismissed'
        await deps.store.updateFindingStatus(id, status)
        if (feedbackMatch[2]) { redirect(response, '/review/ui'); return }
        respondJson(response, 200, { ok: true, status })
        return
      }

      respondJson(response, 404, { error: `没有这个路由: ${method} ${path}` })
    } catch (error) {
      respondJson(response, 500, { error: String((error as Error)?.message ?? error) })
    }
  }
}

async function createRun(deps: HttpDeps, input: { repo: string; pr: number; depth: Depth; mode: PublishMode }) {
  // 面板只给仓库与 PR 号；base/head 必须从平台取，不能猜。
  const pull = await deps.forge.getPull(input.repo, input.pr)
  if (!pull) throw new Error(`找不到 PR ${input.repo}#${input.pr}`)
  const submitted = await deps.scheduler.submit({
    repo: input.repo,
    pr: input.pr,
    baseSha: pull.baseSha,
    headSha: pull.headSha,
    repoPath: deps.repoPathFor(input.repo),
    depth: input.depth,
    mode: input.mode,
    trigger: 'manual',
  })
  // 发起后立即推进；面板每 5 秒刷新，因此不必等它跑完。
  if (!submitted.reused && submitted.runId) {
    void deps.scheduler.start(submitted.runId).catch(() => {})
  }
  return submitted
}

async function runsPageData(deps: HttpDeps, now: () => number) {
  const runs = await deps.store.listRuns({ limit: 200 })
  const rows: RunRow[] = []
  for (const run of runs) {
    const findings = await deps.store.listFindings(run.id)
    rows.push({ run, findingCount: findings.length, heldCount: findings.filter(finding => finding.status === 'held').length })
  }
  const waiting = rows.filter(row => row.run.status === 'waiting' || row.heldCount > 0)
  const running = rows.filter(row => !waiting.includes(row) && (row.run.status === 'running' || row.run.status === 'queued'))
  const finished = rows.filter(row => !waiting.includes(row) && !running.includes(row))
  return {
    waiting, running, finished,
    repos: [...new Set(runs.map(run => run.repo))],
    now: new Date(now()).toISOString().replace('T', ' ').slice(0, 19),
  }
}

async function runDetail(deps: HttpDeps, runId: string): Promise<RunDetailData | undefined> {
  const run = await deps.store.getRun(runId)
  if (!run) return undefined
  const findings = await deps.store.listFindings(runId)
  const stages: StageRow[] = (await deps.store.listStages(runId)).map(stage => ({
    ...stage,
    sessionCount: stage.sessionIds.length,
  }))
  const votesByFinding: RunDetailData['votesByFinding'] = {}
  const feedbackByFinding: RunDetailData['feedbackByFinding'] = {}
  for (const finding of findings) {
    votesByFinding[finding.id] = await deps.store.listVotes(finding.id)
    feedbackByFinding[finding.id] = (await deps.store.listFeedback(finding.id)).map(item => item.verdict)
  }
  let notes: string[] = []
  try {
    const raw = await deps.store.loadProgress(runId)
    if (raw) notes = (JSON.parse(raw) as { notes?: string[] }).notes ?? []
  } catch {}
  return {
    run: run as Run,
    stages,
    findings,
    votesByFinding,
    feedbackByFinding,
    notes,
    now: new Date().toISOString(),
  }
}

/* ---------- 传输层小工具 ---------- */

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function parseJson(text: string): Record<string, unknown> {
  if (text.trim().length === 0) return {}
  try { return JSON.parse(text) as Record<string, unknown> } catch { return {} }
}

function parseForm(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of new URLSearchParams(text)) result[key] = value
  return result
}

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

function respondHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) })
  response.end(html)
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location })
  response.end()
}
