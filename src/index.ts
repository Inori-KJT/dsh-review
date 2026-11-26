/**
 * 插件入口。把前面八个 T 攒出来的部件装成一个能常驻运行的东西。
 *
 * 装配顺序即依赖顺序：存储 → 平台与仓库适配 → 会话适配 → 调度器 → HTTP → 轮询。
 *
 * 配置从一个 JSON 文件读，路径由 DSH_REVIEW_CONFIG 给出。不用宿主配置框架，
 * 理由是这个插件的配置项会随调参频繁变化，而文件形式让"改了哪一项"在 git diff 里可见。
 */
import { appendFileSync, readFileSync } from 'node:fs'

import { buildDeps, type CliDeps } from './app/cli.ts'
import { startServer, type StartedServer } from './app/http.ts'
import { PollingTrigger } from './app/trigger.ts'
import type { Depth } from './core/model.ts'
import type { SessionHost } from './adapters/dsh-agent-runner.ts'

export const name = 'dsh-review'
export const inject = ['sessionController', 'workspaceRegistry']

export interface ReviewConfig {
  /** 状态目录；插件在这里放 SQLite 与运行期文件。 */
  stateDir: string
  /** 面板端口。 */
  port?: number
  /** 仓库 → 本地克隆路径。轮询与 worktree 都用它。 */
  repos: Record<string, string>
  /** 只监听这些仓库；缺省为 repos 的全部键。 */
  targets?: string[]
  /** 轮询间隔，秒。 */
  pollSeconds?: number
  /** 门禁评审的档位。 */
  depth?: Depth
  /** GitCode 令牌所在文件，格式 { "token": "..." }。 */
  tokenConfigPath?: string
  /** 启动后是否立刻恢复上次未跑完的运行。 */
  resumeOnStart?: boolean
}

const turnCounts = new Map<string, number>()

/**
 * 文件探针。存在理由：宿主这条启动路径上 ctx.logger 的输出不可见，
 * 而"插件装了但没生效"与"生效了但某步抛错"必须能区分。
 */
const PROBE_PATH = process.env.DSH_REVIEW_PROBE ?? '/root/zhaochi/t9-plugin.log'
function probe(message: string): void {
  try { appendFileSync(PROBE_PATH, new Date().toISOString() + ' ' + message + '\n') } catch {}
}

export async function apply(ctx: {
  sessionController: SessionHost['sessionController']
  workspaceRegistry: SessionHost['workspaceRegistry']
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  effect?: (setup: () => () => void) => void
  logger?: { info: (message: string, ...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}): Promise<void> {
  probe('apply entered')
  const configPath = process.env.DSH_REVIEW_CONFIG
  if (!configPath) {
    probe('no DSH_REVIEW_CONFIG; not starting')
    ctx.logger?.warn('dsh-review 未启动：没有设置 DSH_REVIEW_CONFIG')
    return
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as ReviewConfig
  if (!config.stateDir) throw new Error('dsh-review 配置缺少 stateDir')
  probe('config loaded: ' + Object.keys(config).join(','))

  // 回合数只有宿主数得出来，所以在这里挂监听并交给适配器。
  try {
    ctx.on?.('session/event', (...args: unknown[]) => {
      const event = args[1] as { type?: string } | undefined
      if (event?.type !== 'turn/start') return
      const session = args[0] as { id?: string; header?: { id?: string } } | undefined
      const id = String(session?.id ?? session?.header?.id ?? '')
      if (id) turnCounts.set(id, (turnCounts.get(id) ?? 0) + 1)
    })
    probe('session/event listener attached')
  } catch (error) {
    probe('session/event listener failed: ' + String(error))
    ctx.logger?.warn('dsh-review 无法挂上 session/event 监听：%s', String(error))
  }

  if (config.tokenConfigPath) process.env.GITCODE_CONFIG = config.tokenConfigPath

  probe('building deps')
  const deps: CliDeps = buildDeps({
    statePath: config.stateDir + '/dsh-review.sqlite',
    sessionHost: { sessionController: ctx.sessionController, workspaceRegistry: ctx.workspaceRegistry },
    repoPaths: config.repos,
    maxConcurrent: 2,
    turnCounter: sessionId => turnCounts.get(sessionId) ?? 0,
  })
  probe('deps built')

  probe('starting panel')
  const server: StartedServer = await startServer({
    store: deps.store,
    scheduler: deps.scheduler,
    forge: deps.forge,
    repoPathFor: repo => config.repos[repo] ?? '',
    port: config.port ?? 3087,
  })
  probe('panel up: ' + server.url)
  ctx.logger?.info('dsh-review 面板：%s', server.url)

  const targets = (config.targets ?? Object.keys(config.repos)).map(repo => ({ repo }))
  const trigger = new PollingTrigger({
    forge: deps.forge,
    submit: request => deps.scheduler.submit(request),
    listRuns: () => deps.store.listRuns({ limit: 500 }),
    repoPathFor: repo => config.repos[repo] ?? '',
    targets,
    depth: config.depth ?? 'standard',
    start: runId => deps.scheduler.start(runId),
  })

  if (config.resumeOnStart !== false) {
    const resumed = await deps.scheduler.resumeAfterRestart()
    probe('resumed ' + resumed.length + ' runs')
    if (resumed.length > 0) ctx.logger?.info('dsh-review 恢复了 %d 次未跑完的运行', resumed.length)
  }

  const intervalMs = (config.pollSeconds ?? 60) * 1000
  const stop = trigger.start(intervalMs, error => {
    probe('poll failed: ' + String(error))
    ctx.logger?.warn('dsh-review 轮询失败：%s', String(error))
  })
  probe('polling started every ' + intervalMs + 'ms')

  // cordis 的 effect 接受一个 setup，setup 返回清理函数；清理函数在部件卸载时才被调用。
  // 写成"setup 里直接清理"会让面板与数据库在启动瞬间就被关掉，症状是端口不监听、
  // 随后每个轮询都报 database is not open。
  ctx.effect?.(() => () => {
    stop()
    void server.close()
    void deps.close()
  })

  probe('started: ' + targets.length + ' targets')
  ctx.logger?.info('dsh-review 已启动：%d 个仓库，每 %d 秒轮询', targets.length, config.pollSeconds ?? 60)
}
