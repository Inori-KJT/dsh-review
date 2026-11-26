/**
 * 阶段表。把九个阶段装配成一张表供 runPipeline 使用。
 *
 * 之所以集中在这里而不是在 run.ts 里直接 import，是为了保持 core 不反向依赖 stages：
 * core 只认 StageFn 这个形状，具体实现在外层注入。将来的 CI 版换一套实现即可。
 */
import type { StageTable } from '../core/run.ts'
import { collect, plan, dedupe, classify, filter } from './deterministic.ts'
import { find, verify } from './agents.ts'
import { gate, publish } from './publish.ts'

export const stageTable: StageTable = {
  collect,
  plan,
  find,
  dedupe,
  verify,
  classify,
  filter,
  gate,
  publish,
}

export { collect, plan, find, dedupe, verify, classify, filter, gate, publish }
export { NotEnabled, summaryBody, inlineBody, markStale } from './publish.ts'
export { applyVerdicts, FINDER_MAX_ITEMS } from './agents.ts'
