/**
 * GitCode 只读适配器。
 *
 * 只实现读取：列 PR、读 PR、读评论、读可合并状态。三个写方法一律抛 NotEnabled，
 * 因为 MVP 的发布模式是"只记录"，任何向平台写的内容都不许从这个类出去。
 *
 * 认证用访问令牌，从 GITCODE_TOKEN 环境变量或 GITCODE_CONFIG 指向的 JSON 文件读。
 * 令牌只进请求参数，不进日志、不进返回值。
 */
import { readFileSync } from 'node:fs'

import type {
  CommentSummary, ForgePort, PullDetail, PullSummary,
} from '../core/ports.ts'

export class NotEnabled extends Error {
  constructor(what: string) {
    super(`${what} 在只读模式下未启用`)
    this.name = 'NotEnabled'
  }
}

export interface GitCodeOptions {
  /** API 根，默认 https://gitcode.com/api/v5 */
  apiBase?: string
  /** 直接给的令牌；不给则依次看 GITCODE_TOKEN 与 GITCODE_CONFIG。 */
  token?: string
  /** 每次请求的超时。 */
  timeoutMs?: number
  /** 注入用：测试替身。 */
  fetchImpl?: typeof fetch
}

function readToken(options: GitCodeOptions): string {
  if (options.token) return options.token
  const fromEnv = process.env.GITCODE_TOKEN
  if (fromEnv) return fromEnv
  const configPath = process.env.GITCODE_CONFIG
  if (!configPath) throw new Error('未提供 GitCode 令牌：设置 GITCODE_TOKEN 或 GITCODE_CONFIG')
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as { token?: string }
  if (!raw.token) throw new Error(`${configPath} 里没有 token 字段`)
  return raw.token
}

export class GitCodeForge implements ForgePort {
  private readonly apiBase: string
  private readonly token: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: GitCodeOptions = {}) {
    this.apiBase = (options.apiBase ?? 'https://gitcode.com/api/v5').replace(/\/+$/, '')
    this.token = readToken(options)
    this.timeoutMs = options.timeoutMs ?? 20000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(`${this.apiBase}${path}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
    // 令牌只在这里出现，绝不进日志。
    url.searchParams.set('access_token', this.token)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`GitCode ${path} 返回 ${response.status}: ${body.slice(0, 200)}`)
      }
      return await response.json() as T
    } finally {
      clearTimeout(timer)
    }
  }

  async listPulls(query: { repo: string; state: 'open' | 'all'; updatedSince?: string }): Promise<PullSummary[]> {
    const rows = await this.get<GitCodePull[]>(`/repos/${query.repo}/pulls`, {
      state: query.state === 'open' ? 'open' : 'all',
      per_page: 50,
    })
    return rows.map(toSummary).filter(pull => pull.headSha.length > 0)
  }

  async getPull(repo: string, pr: number): Promise<PullDetail | undefined> {
    try {
      const row = await this.get<GitCodePull>(`/repos/${repo}/pulls/${pr}`)
      return { ...toSummary(row), title: row.title ?? '', description: row.body ?? '' }
    } catch (error) {
      if (String(error).includes('返回 404')) return undefined
      throw error
    }
  }

  async listComments(repo: string, pr: number): Promise<CommentSummary[]> {
    try {
      const rows = await this.get<GitCodeComment[]>(`/repos/${repo}/pulls/${pr}/comments`, { per_page: 100 })
      return rows.map(row => ({
        id: String(row.id),
        author: row.user?.login ?? row.user?.username ?? '',
        body: row.body ?? '',
        at: row.created_at ?? '',
      }))
    } catch (error) {
      // PR 评论接口在部分仓库不可用，退成议题评论；仍失败则视为无评论。
      try {
        const rows = await this.get<GitCodeComment[]>(`/repos/${repo}/issues/${pr}/comments`, { per_page: 100 })
        return rows.map(row => ({
          id: String(row.id),
          author: row.user?.login ?? row.user?.username ?? '',
          body: row.body ?? '',
          at: row.created_at ?? '',
        }))
      } catch {
        if (String(error).includes('返回 404')) return []
        throw error
      }
    }
  }

  async readMergeable(repo: string, pr: number): Promise<{ mergeable: boolean; conflictPassed: boolean }> {
    const row = await this.get<GitCodePull>(`/repos/${repo}/pulls/${pr}`)
    return { mergeable: row.mergeable !== false, conflictPassed: row.conflict_passed !== false }
  }

  /* ---------- 以下三个是写操作，只读模式一律拒绝 ---------- */

  async postInline(): Promise<void> {
    throw new NotEnabled('行内评论')
  }

  async postSummary(): Promise<void> {
    throw new NotEnabled('摘要评论')
  }

  async setStatus(): Promise<void> {
    throw new NotEnabled('commit status')
  }

  async listReplies(): Promise<CommentSummary[]> {
    return []
  }
}

interface GitCodePull {
  number: number
  title?: string
  body?: string
  state?: string
  mergeable?: boolean
  conflict_passed?: boolean
  head?: { sha?: string; ref?: string }
  base?: { sha?: string; ref?: string }
  user?: { login?: string; username?: string }
  updated_at?: string
}

interface GitCodeComment {
  id: number | string
  body?: string
  user?: { login?: string; username?: string }
  created_at?: string
}

function toSummary(row: GitCodePull): PullSummary {
  return {
    number: row.number,
    headSha: row.head?.sha ?? '',
    baseSha: row.base?.sha ?? '',
    author: row.user?.login ?? row.user?.username ?? '',
    updatedAt: row.updated_at ?? '',
  }
}
