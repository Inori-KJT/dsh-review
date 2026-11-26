/**
 * 轮询触发。只看 head 变化，其余事件一律不建运行。
 *
 * 这是第 1 条不变量的实现位置：评论、回复、线程 resolve 只该写 feedback，
 * 永远不能创建运行。因此本模块只比较 head，不读评论内容做触发。
 *
 * 增量重审的规则也在这里：同一 PR 的新 head 触发第 N+1 轮，`since` 取上一轮的 head。
 */
import type { Depth, PublishMode, ReviewKind, Run } from '../core/model.ts'
import type { ForgePort } from '../core/ports.ts'
import type { SubmitResult } from './scheduler.ts'

export interface TriggerTarget {
  repo: string
  /** 只看基于这些分支的 PR；为空表示不过滤。 */
  baseRefs?: string[]
}

export interface PollingTriggerOptions {
  forge: ForgePort
  /** 提交入口，注入 Scheduler 的 submit。 */
  submit: (request: {
    repo: string
    pr: number
    baseSha: string
    headSha: string
    repoPath: string
    since?: string
    depth?: Depth
    mode?: PublishMode
    reviewKind?: ReviewKind
    round?: number
    trigger?: Run['trigger']
  }) => Promise<SubmitResult>
  /** 查已有运行，用来算轮次与 since。 */
  listRuns: () => Promise<Run[]>
  /** 每个仓库在本地的克隆路径。 */
  repoPathFor: (repo: string) => string
  targets: TriggerTarget[]
  depth?: Depth
  mode?: PublishMode
  /**
   * 提交之后推进该运行。不给就只提交，运行会停在 queued。
   * 单独拆出来，是为了让"提交"与"推进"各自可测，也便于将来换成队列。
   */
  start?: (runId: string) => Promise<unknown>
}

export interface PollOutcome {
  /** 本次新建或复用的运行。 */
  submitted: Array<{ repo: string; pr: number; headSha: string; runId: string; reused: boolean; round: number; since?: string }>
  /** 被熔断拦下的。 */
  blocked: Array<{ repo: string; pr: number; reason: string }>
  /** 因 head 未变而跳过的。 */
  unchanged: number
}

export class PollingTrigger {
  private readonly options: PollingTriggerOptions

  constructor(options: PollingTriggerOptions) {
    this.options = options
  }

  /** 跑一轮：列出所有开放 PR，只对 head 变了的提交评审。 */
  async pollOnce(): Promise<PollOutcome> {
    const outcome: PollOutcome = { submitted: [], blocked: [], unchanged: 0 }
    const runs = await this.options.listRuns()

    for (const target of this.options.targets) {
      const pulls = await this.options.forge.listPulls({ repo: target.repo, state: 'open' })
      for (const pull of pulls) {
        if (pull.headSha.length === 0) continue
        const history = runs
          .filter(run => run.repo === target.repo && run.pr === pull.number)
          .sort((a, b) => a.round - b.round)

        const sameHead = history.find(run => run.headSha === pull.headSha)
        if (sameHead) {
          outcome.unchanged += 1
          continue
        }

        const last = history.at(-1)
        const round = last ? last.round + 1 : 1
        const since = last?.headSha

        const result = await this.options.submit({
          repo: target.repo,
          pr: pull.number,
          baseSha: pull.baseSha,
          headSha: pull.headSha,
          repoPath: this.options.repoPathFor(target.repo),
          since,
          depth: this.options.depth ?? 'standard',
          mode: this.options.mode ?? 'record',
          reviewKind: 'bug',
          round,
          trigger: 'poll',
        })
        if (result.circuitOpen) {
          outcome.blocked.push({ repo: target.repo, pr: pull.number, reason: result.reason ?? '熔断' })
          continue
        }
        outcome.submitted.push({
          repo: target.repo,
          pr: pull.number,
          headSha: pull.headSha,
          runId: result.runId,
          reused: result.reused,
          round,
          since,
        })
        // 新提交的运行立刻推进；复用的不动，它已经在跑或已跑完。
        if (!result.reused && result.runId) {
          await this.options.start?.(result.runId)
        }
      }
    }
    return outcome
  }

  /** 常驻轮询。返回 stop 函数。 */
  start(intervalMs = 60_000, onError?: (error: unknown) => void): () => void {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      if (stopped) return
      try { await this.pollOnce() } catch (error) { onError?.(error) }
      if (!stopped) timer = setTimeout(tick, intervalMs)
    }
    void tick()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }
}
