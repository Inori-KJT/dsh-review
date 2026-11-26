/**
 * 命令行入口。
 *
 * 四个子命令：
 *   run     对一个 PR，或一对 base/head，跑一次评审
 *   list    列出最近的运行
 *   inspect 看一次运行的发现、投票、阶段、事件
 *   trigger 跑一轮轮询触发（--once 只跑一轮）
 *
 * 它只调同一套 core 与 adapters，不复制逻辑；面板将来调的 HTTP 接口也一样。
 */
import { GitCli } from '../adapters/git-cli.ts'
import { GitCodeForge } from '../adapters/gitcode-forge.ts'
import { SqliteStore } from '../adapters/sqlite-store.ts'
import { DshAgentRunner } from '../adapters/dsh-agent-runner.ts'
import { stageTable } from '../stages/index.ts'
import { Scheduler } from './scheduler.ts'
import { PollingTrigger } from './trigger.ts'
import type { Depth, PublishMode } from '../core/model.ts'
import type { ForgePort } from '../core/ports.ts'

export interface CliDeps {
  store: SqliteStore
  scheduler: Scheduler
  forge: GitCodeForge
  vcs: GitCli
  runner: DshAgentRunner
  close: () => Promise<void>
}

/** 构造完整依赖。宿主或脚本注入 sessionController 与 workspaceRegistry。 */
export function buildDeps(input: {
  statePath: string
  sessionHost: ConstructorParameters<typeof DshAgentRunner>[0]
  gitcodeToken?: string
  repoPaths: Record<string, string>
  maxConcurrent?: number
  /**
   * 可替换的平台客户端。评测跑本地仓库时用不到平台，因此允许传一个空实现，
   * 免得为了让本地评测跑起来而先准备令牌。
   */
  forge?: ForgePort
  /** 回合数读取器，由宿主在 session/event 上统计后注入。 */
  turnCounter?: (sessionId: string) => number
}): CliDeps {
  const store = new SqliteStore(input.statePath)
  const vcs = new GitCli({ token: input.gitcodeToken })
  const forge = input.forge ?? new GitCodeForge({ token: input.gitcodeToken })
  const runner = new DshAgentRunner(input.sessionHost, {
    finderPreset: 'dsh-review-finder',
    verifierPreset: 'dsh-review-verifier',
    readOnlyTools: ['glob', 'grep', 'working_directory'],
    turnCounter: input.turnCounter,
  })
  const scheduler = new Scheduler({
    store,
    deps: { vcs, forge, agents: runner },
    table: stageTable,
    maxConcurrent: input.maxConcurrent ?? 4,
  })
  return { store, scheduler, forge: forge as GitCodeForge, vcs, runner, close: () => store.close() }
}

export interface RunArgs {
  repo: string
  pr?: number
  base?: string
  head?: string
  depth?: Depth
  mode?: PublishMode
  wait?: boolean
  round?: number
  since?: string
}

/** 执行一次评审。返回 runId 与最终状态。 */
export async function runOnce(deps: CliDeps, args: RunArgs, repoPath: string): Promise<{ runId: string; reused: boolean; status?: string }> {
  let base = args.base
  let head = args.head
  if (args.pr !== undefined) {
    const pull = await deps.forge.getPull(args.repo, args.pr)
    if (!pull) throw new Error(`找不到 PR ${args.repo}#${args.pr}`)
    base = base ?? pull.baseSha
    head = head ?? pull.headSha
  }
  if (!base || !head) throw new Error('需要 --pr，或者同时给 --base 与 --head')

  const submitted = await deps.scheduler.submit({
    repo: args.repo,
    pr: args.pr ?? 0,
    baseSha: base,
    headSha: head,
    repoPath,
    since: args.since,
    depth: args.depth ?? 'standard',
    mode: args.mode ?? 'record',
    round: args.round ?? 1,
    trigger: args.pr !== undefined ? 'manual' : 'cli',
  })
  if (submitted.circuitOpen) return { runId: '', reused: false, status: 'circuit_open' }
  if (args.wait !== false && !submitted.reused) {
    const state = await deps.scheduler.start(submitted.runId)
    return { runId: submitted.runId, reused: false, status: state?.run.status }
  }
  const run = await deps.store.getRun(submitted.runId)
  return { runId: submitted.runId, reused: submitted.reused, status: run?.status }
}

/** 跑一轮轮询。 */
export async function runTrigger(deps: CliDeps, input: {
  targets: Array<{ repo: string }>
  repoPaths: Record<string, string>
  depth?: Depth
  once?: boolean
}): Promise<unknown> {
  const trigger = new PollingTrigger({
    forge: deps.forge,
    submit: request => deps.scheduler.submit(request),
    listRuns: () => deps.store.listRuns({ limit: 500 }),
    repoPathFor: repo => input.repoPaths[repo] ?? '',
    targets: input.targets,
    depth: input.depth ?? 'standard',
  })
  const outcome = await trigger.pollOnce()
  if (!input.once) {
    for (const item of outcome.submitted) {
      if (!item.reused) await deps.scheduler.start(item.runId)
    }
  }
  return outcome
}

/** 极简参数解析，避免引入依赖。 */
export function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const [command, ...rest] = argv
  const flags: Record<string, string | boolean> = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    const next = rest[index + 1]
    if (next === undefined || next.startsWith('--')) { flags[name] = true; continue }
    flags[name] = next
    index += 1
  }
  return { command: command ?? 'help', flags }
}

export const USAGE = `用法：
  dsh-review run --repo <owner/name> --pr <N> [--depth quick|standard] [--mode record]
  dsh-review run --repo <owner/name> --base <sha> --head <sha>
  dsh-review list [--limit 20]
  dsh-review inspect --id <runId>
  dsh-review trigger --repos <owner/a,owner/b> --once`
