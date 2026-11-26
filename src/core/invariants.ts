/**
 * 八条防循环不变量。全部是纯函数，不依赖任何外部状态，便于逐条单测。
 *
 * 它们存在的理由：评审引擎最容易出的不是质量问题，是"来回不收敛"。
 * 三条循环路径分别是：引擎发评论→superagent 修复并推送→引擎再审；
 * superagent 在线程里回复→引擎当成新事件；执行器反复调用提交前自审。
 * 下面每一条都对应切断其中一条路径的一段。
 */
import { allow, deny, type InvariantVerdict, type ReviewKind } from './model.ts'

/** 能产生一次新评审运行的事件。只有 head 变化算。 */
export type ReviewEvent = 'head-changed' | 'comment' | 'reply' | 'thread-resolved' | 'self-review'

/** 第 1 条：只有 head commit 变化能触发门禁评审；其余事件只写反馈。 */
export function invariantRunSource(event: ReviewEvent): InvariantVerdict {
  if (event === 'head-changed') return allow()
  if (event === 'self-review') return allow()
  return deny('notACodeChange', `${event} 不是代码变动的信号，只写入 feedback，不创建运行`)
}

/** 第 2 条：同一 (仓库, PR, 评审类型, head) 最多评审一次，重复请求返回已有运行。 */
export function invariantOneRunPerHead(existingRunId: string | undefined): InvariantVerdict {
  if (existingRunId) return deny('alreadyReviewed', `该 head 已有运行 ${existingRunId}，应直接返回它`)
  return allow()
}

/** 第 3 条：每种评审类型最多三轮。 */
export const MAX_ROUNDS = 3

export function invariantRoundCap(round: number, reviewKind: ReviewKind): InvariantVerdict {
  if (round <= MAX_ROUNDS) return allow()
  return deny('roundCapReached', `${reviewKind} 已审 ${MAX_ROUNDS} 轮，新推送不再自动评审，转 needs_human`)
}

/** 第 3 条的后半：第 2 轮起只看上次评审以来的差异。 */
export function roundWindow(round: number, lastReviewedSha: string | undefined): { since?: string } {
  if (round <= 1 || !lastReviewedSha) return {}
  return { since: lastReviewedSha }
}

/** 第 3 条的另一半：第 3 轮只报 Important。 */
export function severitiesForRound(round: number): Array<'important' | 'nit'> {
  return round >= MAX_ROUNDS ? ['important'] : ['important', 'nit']
}

/** 第 4 条：未解决的同一指纹不重复发布；已判误报或有意为之的不再报。 */
export type PriorFindingState = 'open' | 'false-positive' | 'intended' | 'unimportant' | 'resolved' | 'dismissed'

export function invariantFingerprintLifecycle(prior: PriorFindingState | undefined): InvariantVerdict {
  switch (prior) {
    case undefined:
      return allow()
    case 'open':
      return deny('alreadyOpen', '同一指纹仍处于未解决状态，不重复发布')
    case 'false-positive':
      return deny('markedFalsePositive', '已被标为误报，后续轮次不再报')
    case 'intended':
      return deny('markedIntended', '已被标为有意为之，后续轮次不再报')
    case 'resolved':
      return allow()
    case 'unimportant':
      return deny('markedUnimportant', '已被标为不重要，后续轮次不再报')
    case 'dismissed':
      return deny('markedDismissed', '已被人处置过，后续轮次不再报')
  }
}

/** 第 5 条：引擎忽略自己账号与名单内机器人的评论。 */
export function invariantIgnoreOwnComments(
  login: string,
  selfLogins: readonly string[],
  reviewBots: readonly string[],
): InvariantVerdict {
  if (selfLogins.includes(login)) return deny('ownAccount', `${login} 是引擎自己的账号，忽略`)
  if (reviewBots.includes(login)) return deny('reviewBot', `${login} 是名单内机器人，忽略`)
  return allow()
}

/** 第 6 条：提交前自审按分支限次。 */
export const SELF_REVIEW_PER_HOUR = 2

export interface SelfReviewHistory {
  /** 该分支上最近若干次自审的时刻（毫秒）。 */
  times: readonly number[]
  /** 已经审过的 head。 */
  heads: readonly string[]
}

export function invariantSelfReviewQuota(
  history: SelfReviewHistory,
  headSha: string,
  now: number,
): InvariantVerdict {
  if (history.heads.includes(headSha)) return deny('headAlreadySelfReviewed', '该 head 已自审过，返回上次结果')
  const withinHour = history.times.filter(time => now - time < 3_600_000).length
  if (withinHour >= SELF_REVIEW_PER_HOUR) {
    return deny('selfReviewQuota', `该分支一小时内已自审 ${withinHour} 次，超限返回上次结果`)
  }
  return allow()
}

/** 第 7 条：自审结果不发到 PR，只返回给调用者。 */
export function invariantSelfReviewSilent(trigger: 'poll' | 'manual' | 'cli' | 'self-review'): InvariantVerdict {
  if (trigger === 'self-review') return deny('selfReviewIsSilent', '自审结果只返回调用者，不发评论、不写 status')
  return allow()
}

/** 第 8 条：全局熔断，同一 PR 24 小时内运行次数上限。 */
export const RUNS_PER_DAY = 6

export function invariantCircuitBreaker(runsInLast24h: number): InvariantVerdict {
  if (runsInLast24h < RUNS_PER_DAY) return allow()
  return deny('circuitOpen', `该 PR 24 小时内已运行 ${runsInLast24h} 次，暂停自动评审，面板显示等你处理`)
}
