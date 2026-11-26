/**
 * 阶段接口。序列由引擎代码决定，模型只在阶段内部做判断。
 *
 * 三个状态的设计理由：done 表示可以进下一阶段；waiting 表示停下来等人（gate）；
 * failed 带 retryable 表示可不可以重试。把"等人"和"失败"分开，是因为
 * 两者的处置完全不同——前者要通知人，后者要退避重试。
 */
import type { StageId, StageKind } from './model.ts'
import type { BudgetLimits, BudgetUsed } from './budget.ts'

/**
 * 取消信号的最小结构声明。宿主的 AbortSignal 天然满足它，
 * 但这里只要这两样，因此 core 不依赖任何运行时全局。
 */
export interface CancelSignal {
  readonly aborted: boolean
  addEventListener?(type: 'abort', listener: () => void): void
}

export interface StageContext<C> {
  /** 该阶段的配置，由面板按 configSchema 生成表单。 */
  config: C
  runId: string
  limits: BudgetLimits
  used: BudgetUsed
  /** 该阶段可用的外部能力，全部是接口，实现在 adapters 里。 */
  ports: Record<string, unknown>
  /** 进度事件，推给面板。 */
  emit(event: { type: string; payload?: Record<string, unknown> }): void
  /** 暂停与取消信号。用最小结构类型声明，避免依赖宿主的 AbortSignal。 */
  signal: CancelSignal
}

export type StageResult<O> =
  | { status: 'done'; output: O }
  | { status: 'waiting'; reason: string }
  | { status: 'failed'; error: string; retryable: boolean }

export interface Stage<I, O, C> {
  id: StageId
  kind: StageKind
  /** 面板据此自动生成表单；确定性阶段通常没有可配项。 */
  run(ctx: StageContext<C>, input: I): Promise<StageResult<O>>
}

export const done = <O>(output: O): StageResult<O> => ({ status: 'done', output })
export const waiting = (reason: string): StageResult<never> => ({ status: 'waiting', reason })
export const failed = (error: string, retryable = false): StageResult<never> => ({ status: 'failed', error, retryable })
