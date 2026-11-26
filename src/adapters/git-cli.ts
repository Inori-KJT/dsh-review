/**
 * 用 git 命令行实现的 VcsPort。
 *
 * 三条决定：
 *   1 diff 用 --unified=0 解析 hunk 头，只取行号范围，不保存整段文本，
 *      因为引擎只需要"哪些行变了"，需要内容时按 sha 单独读。
 *   2 readFileAt 一律按 sha 读（git show sha:path），保证读到的是那个版本，
 *      不受工作区当前状态影响。规则文件必须从 base 读，靠的就是这一点。
 *   3 worktree 建出来后设为只读（去掉写位），运行结束再恢复并清理。
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { BlameLine, DiffSummary, VcsPort } from '../core/ports.ts'
import type { CommitView } from '../app/eval.ts'

export interface GitCliOptions {
  /** 需要时用来取私有仓库的令牌；只用于 fetch。 */
  token?: string
  /** 远端地址；令牌存在时用它拼带凭据的临时 URL。 */
  remoteUrl?: string
  /** 单条 git 命令的超时。 */
  timeoutMs?: number
}

export class GitCli implements VcsPort {
  private readonly options: GitCliOptions

  constructor(options: GitCliOptions = {}) {
    this.options = options
  }

  private git(repoPath: string, args: string[], allowFailure = false): string {
    try {
      return execFileSync('git', ['-C', repoPath, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.options.timeoutMs ?? 120000,
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch (error) {
      if (allowFailure) return ''
      throw error
    }
  }

  /** 确保本地有该 sha；没有就 fetch。 */
  async ensureSha(repoPath: string, sha: string): Promise<void> {
    try {
      this.git(repoPath, ['cat-file', '-e', `${sha}^{commit}`])
      return
    } catch {}
    const remote = this.options.remoteUrl ?? this.git(repoPath, ['remote', 'get-url', 'origin']).trim()
    const url = this.options.token && remote.startsWith('https://')
      ? remote.replace('https://', `https://oauth2:${this.options.token}@`)
      : remote
    this.git(repoPath, ['fetch', '--no-tags', '--quiet', url, sha])
  }

  async diff(repoPath: string, base: string, head: string): Promise<DiffSummary> {
    await this.ensureSha(repoPath, base)
    await this.ensureSha(repoPath, head)
    const raw = this.git(repoPath, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '-M', '-C', base, head])
    const changedFiles: string[] = []
    const hunks: DiffSummary['hunks'] = []
    let changedLines = 0
    let current: string | undefined

    for (const line of raw.split('\n')) {
      if (line.startsWith('diff --git ')) {
        const match = / b\/(.+)$/.exec(line)
        current = match?.[1]
        if (current && !changedFiles.includes(current)) changedFiles.push(current)
        continue
      }
      if (line.startsWith('rename to ')) {
        current = line.slice('rename to '.length).trim()
        if (!changedFiles.includes(current)) changedFiles.push(current)
        continue
      }
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (hunk && current) {
        const newStart = Number(hunk[2])
        const lines = Number(hunk[3] ?? 1)
        hunks.push({ path: current, oldStart: Number(hunk[1]), newStart, lines })
        changedLines += lines
      }
    }
    return { changedFiles, changedLines, hunks }
  }

  async blame(repoPath: string, sha: string, path: string): Promise<BlameLine[]> {
    const raw = this.git(repoPath, ['blame', '--line-porcelain', sha, '--', path], true)
    if (!raw) return []
    const lines: BlameLine[] = []
    let currentSha = ''
    let currentAuthor = ''
    for (const line of raw.split('\n')) {
      if (/^[0-9a-f]{40} /.test(line)) {
        currentSha = line.split(' ')[0]
        continue
      }
      if (line.startsWith('author ')) { currentAuthor = line.slice(7); continue }
      const tab = /^\t(.*)$/.exec(line)
      if (tab) {
        lines.push({ line: lines.length + 1, sha: currentSha, author: currentAuthor })
      }
    }
    return lines
  }

  async readFileAt(repoPath: string, sha: string, path: string): Promise<string | undefined> {
    await this.ensureSha(repoPath, sha)
    const text = this.git(repoPath, ['show', `${sha}:${path}`], true)
    return text.length > 0 ? text : undefined
  }

  async makeWorktree(repoPath: string, sha: string, targetDir: string, readOnly: boolean): Promise<void> {
    await this.ensureSha(repoPath, sha)
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true })
    this.git(repoPath, ['worktree', 'add', '--detach', '--force', targetDir, sha])
    if (readOnly) setReadOnly(targetDir, true)
  }

  async removeWorktree(targetDir: string): Promise<void> {
    if (!existsSync(targetDir)) return
    try { setReadOnly(targetDir, false) } catch {}
    // 找到它属于哪个仓库，交给 git 清理登记；找不到就直接删目录。
    const parent = targetDir.replace(/\/[^/]+$/, '')
    try {
      this.git(parent, ['worktree', 'remove', '--force', targetDir])
    } catch {
      rmSync(targetDir, { recursive: true, force: true })
    }
  }

  async buildCandidate(): Promise<{ sha: string; conflicts: string[] }> {
    throw new Error('buildCandidate 属于 V2 的合并候选版本，MVP 未实现')
  }
}

/** 递归设置或恢复写位。只改权限位，不改时间戳。 */
export function setReadOnly(root: string, readOnly: boolean): void {
  const mode = readOnly ? 0o555 : 0o755
  const fileMode = readOnly ? 0o444 : 0o644
  walk(root)
  function walk(path: string): void {
    let info
    try { info = statSync(path) } catch { return }
    if (info.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (entry === '.git') continue
        walk(join(path, entry))
      }
      try { chmodSync(path, mode) } catch {}
      return
    }
    try { chmodSync(path, fileMode) } catch {}
  }
}

/**
 * 读提交历史，供评测集挖掘用。
 *
 * 一次 `git log -p` 拿全：提交头用不可见分隔符切分，hunk 头给出行范围。
 * 分两次调用会需要 N 次 git show，历史稍长就慢到不可用。
 */
export function readCommitViews(repoPath: string, limit = 400): CommitView[] {
  const raw = execFileSync('git', [
    '-C', repoPath, 'log', `-n${limit}`, '--unified=0', '--no-color', '--no-ext-diff',
    '--date=iso-strict',
    '--pretty=format:@@DSHREVIEW@@%H%x09%P%x09%aI%x09%s%x09%b%x1e',
    '-p',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 })

  const commits: CommitView[] = []
  const blocks = raw.split('@@DSHREVIEW@@').slice(1)
  for (const block of blocks) {
    const marker = block.indexOf('\u001e')
    if (marker < 0) continue
    const header = block.slice(0, marker)
    const diffText = block.slice(marker + 1)
    const fields = header.split('\t')
    const sha = fields[0]?.trim() ?? ''
    if (!sha) continue
    const parents = (fields[1] ?? '').trim().split(/\s+/).filter(Boolean)
    const at = fields[2]?.trim() ?? ''
    const subject = fields[3]?.trim() ?? ''
    const body = (fields[4] ?? '').trim()

    const changes: CommitView['changes'] = []
    let current: string | undefined
    for (const line of diffText.split('\n')) {
      if (line.startsWith('diff --git ')) {
        const match = / b\/(.+)$/.exec(line)
        current = match?.[1]
        continue
      }
      if (line.startsWith('rename to ')) { current = line.slice('rename to '.length).trim(); continue }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (hunk && current) {
        changes.push({ path: current, newStart: Number(hunk[1]), lines: Number(hunk[2] ?? 1) })
      }
    }
    commits.push({ sha, parents, subject, body, at, changes })
  }
  return commits
}