/**
 * 流水线：阶段顺序与档位预设。
 *
 * 顺序写死在这里而不是配置里，因为顺序本身是正确性的一部分：
 * 先去重再核实，先分类再过滤，先过滤再让人放行。
 * 面板只能开关阶段，不能改顺序。
 */
import type { Depth, StageId, StageKind } from './model.ts'
import { BUDGETS, type BudgetLimits } from './budget.ts'

export const STAGE_ORDER: readonly StageId[] = [
  'collect',
  'plan',
  'find',
  'dedupe',
  'verify',
  'classify',
  'filter',
  'gate',
  'publish',
]

export const STAGE_KIND: Record<StageId, StageKind> = {
  collect: 'deterministic',
  plan: 'deterministic',
  find: 'agent',
  dedupe: 'deterministic',
  verify: 'agent',
  classify: 'deterministic',
  filter: 'deterministic',
  gate: 'human',
  publish: 'deterministic',
}

/** 只有这两个阶段会起 agent 会话。 */
export const AGENT_STAGES: readonly StageId[] = ['find', 'verify']

/** 一个档位 = 一组阶段配置。 */
export interface DepthPreset {
  depth: Depth
  limits: BudgetLimits
  /** 起哪几个 finder。MVP 只有前两个。 */
  finderProfiles: readonly string[]
  /** 该档位启用的阶段，其余跳过。 */
  stages: readonly StageId[]
  /** 是否要人工放行。 */
  gate: boolean
  /** 是否做核实投票。quick 档单票，standard 起两票。 */
  verify: boolean
}

export const PRESETS: Record<Depth, DepthPreset> = {
  quick: {
    depth: 'quick',
    limits: BUDGETS.quick,
    finderProfiles: ['correctness'],
    stages: ['collect', 'plan', 'find', 'dedupe', 'verify', 'classify', 'filter', 'publish'],
    gate: false,
    verify: true,
  },
  standard: {
    depth: 'standard',
    limits: BUDGETS.standard,
    finderProfiles: ['correctness', 'security'],
    stages: STAGE_ORDER,
    gate: true,
    verify: true,
  },
  deep: {
    depth: 'deep',
    limits: BUDGETS.deep,
    finderProfiles: ['correctness', 'security', 'conventions', 'intent'],
    stages: STAGE_ORDER,
    gate: true,
    verify: true,
  },
}

/** 取某档下一个该执行的阶段；没有下一个时返回 undefined。 */
export function nextStage(depth: Depth, current: StageId): StageId | undefined {
  const stages = PRESETS[depth].stages
  const index = stages.indexOf(current)
  return index < 0 || index === stages.length - 1 ? undefined : stages[index + 1]
}

/** 该档是否启用某个阶段。 */
export function stageEnabled(depth: Depth, stage: StageId): boolean {
  return PRESETS[depth].stages.includes(stage)
}
