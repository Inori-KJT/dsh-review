/**
 * DSH 会话适配器：把一个 AgentRunnerRequest 变成一次真实的 DSH 会话。
 *
 * 这个文件里的每一条写法都来自 T0b 的实测，不是从文档推的：
 *   - 建会话用 sessionController.create（不是 createSession）
 *   - restrict 的允许名单只能写全局工具名，自己注册的工具对限制免疫
 *   - 注册工具时 output 必须同时给 schema 与 render
 *   - 守卫读 execution.arguments，不是 execution.args
 *   - 投递来源必须用 user-rpc，自定义来源会被静默丢弃
 *   - 等待靠轮询 agent.status，判据是"先见到 running 再见到 idle"
 *
 * 只依赖结构类型，不 import 任何 @deepseek-ai 包，因此可以用假宿主单测。
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import type { AgentRunner, AgentRunnerRequest, AgentRunnerResult } from '../core/ports.ts'

/* ---------- 宿主的结构类型 ---------- */

export interface ToolScope {
  restrict?(filter: { allow: string[] }): () => void
  guard?(guard: (execution: { name?: string; arguments?: unknown }) => string | undefined): () => void
  register?(tool: {
    name: string
    description: string
    parameters: unknown
    output: { schema: unknown; render: (args: unknown, value: unknown) => unknown }
    execute: (args: unknown, execution?: unknown) => unknown
  }): () => void
}

export interface AgentLike {
  id: string
  status: string
  session?: { header?: { cwd?: string; agentPreset?: string } }
  ctx?: { tools?: ToolScope }
  followup(message: unknown): void
  cancel?(): void
}

export interface SessionHost {
  sessionController: {
    resolveAgent(sessionId: string): Promise<{ agent?: AgentLike } | { error: unknown }>
    create(request: { sessionId: string; workspaceId: string; agentPreset?: string }): Promise<unknown>
    rename?(request: { sessionId: string; title: string }): Promise<unknown>
  }
  workspaceRegistry: { create(cwd: string): Promise<{ id: string }> }
}

/* ---------- 选项 ---------- */

export interface DshAgentRunnerOptions {
  /** 会话预设名，由 cordis.patch.yml 定义。 */
  finderPreset: string
  verifierPreset: string
  /** 允许的只读全局工具，只能写全局名。 */
  readOnlyTools: string[]
  /** 一个步骤内轮询 agent.status 的间隔。 */
  pollMs?: number
  /** 起会话之后、发提示词之前的额外装饰（例如设置模型）。 */
  decorate?: (agent: AgentLike, request: AgentRunnerRequest<unknown>) => Promise<void>
  /** 会话追踪：把 sessionId 与标题交出去，供面板跳转。 */
  onSession?: (info: { sessionId: string; role: string; profile: string; title: string }) => void
  /** 回合数读取器，由宿主从 session/event 统计后注入。 */
  turnCounter?: (sessionId: string) => number
}

export const DEFAULT_READ_ONLY_TOOLS = ['glob', 'grep', 'working_directory']

/* ---------- 路径围栏 ---------- */

/**
 * 把任意输入路径解析到 worktree 内的真实路径；越界返回 undefined。
 * 做两道判断：字面规范化，以及 realpath 复核，后者挡住指向外部的符号链接。
 */
export function containPath(root: string, raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const rootReal = safeRealpath(root) ?? resolve(root)
  const candidate = isAbsolute(raw) ? raw : resolve(rootReal, raw)
  const lexical = resolve(candidate)
  if (lexical !== rootReal && !lexical.startsWith(rootReal + '/')) return undefined
  const real = safeRealpath(lexical)
  if (real === undefined) {
    // 文件不存在时 realpath 会失败；此时只认字面判断的结果，且要求它确实在 root 内。
    return lexical === rootReal || lexical.startsWith(rootReal + '/') ? lexical : undefined
  }
  return real === rootReal || real.startsWith(rootReal + '/') ? real : undefined
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/* ---------- 运行器 ---------- */

export class DshAgentRunner implements AgentRunner {
  private readonly host: SessionHost
  private readonly options: DshAgentRunnerOptions
  private seq = 0

  constructor(host: SessionHost, options: DshAgentRunnerOptions) {
    this.host = host
    this.options = options
  }

  async run<T>(request: AgentRunnerRequest<T>): Promise<AgentRunnerResult<T>> {
    const startedAt = Date.now()
    const preset = request.role === 'finder' ? this.options.finderPreset : this.options.verifierPreset
    const sessionId = `dsh-review-${request.role}-${(this.seq += 1).toString().padStart(3, '0')}-${startedAt}`
    const items: T[] = []
    const disposers: Array<() => void> = []
    let ended: AgentRunnerResult<T>['ended'] = 'error'

    if (request.signal?.aborted) {
      return { sessionId, items, usage: { turns: 0, durationMs: 0 }, ended: 'error' }
    }

    const agent = await this.ensureAgent(sessionId, request.cwd, preset, request)
    if (!agent) return { sessionId, items, usage: { turns: 0, durationMs: Date.now() - startedAt }, ended: 'error' }

    try {
      // 1 限制工具：只写全局工具名；自己注册的工具对限制免疫。
      const allow = [...new Set([...this.options.readOnlyTools, ...request.readOnlyTools])]
        .filter(name => this.options.readOnlyTools.includes(name) || DEFAULT_READ_ONLY_TOOLS.includes(name))
      const tools = agent.ctx?.tools
      if (tools?.restrict) disposers.push(tools.restrict({ allow }))

      // 2 守卫：读 execution.arguments，越界即拒。
      if (tools?.guard) {
        disposers.push(tools.guard(execution => {
          const args = (execution?.arguments ?? {}) as Record<string, unknown>
          const raw = args.path ?? args.file_path ?? args.filePath
          if (typeof raw !== 'string') return undefined
          return containPath(request.cwd, raw) ? undefined : `拒绝访问工作目录之外的路径: ${raw}`
        }))
      }

      // 3 自注册只读工具，把路径判断放在引擎侧，不依赖宿主行为。
      if (tools?.register) {
        disposers.push(tools.register({
          name: 'read_file',
          description: '读取工作目录内某个相对路径的文本。只接受相对路径，越界一律拒绝。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['path'],
            properties: { path: { type: 'string' }, limit: { type: 'integer', minimum: 1 } },
          },
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: args => {
            const input = args as { path?: string; limit?: number }
            const target = containPath(request.cwd, input.path)
            if (!target) throw new Error(`拒绝：${String(input.path)} 在允许范围之外`)
            if (!statSync(target).isFile()) throw new Error(`不是文件: ${String(input.path)}`)
            const text = readFileSync(target, 'utf8').split('\n').slice(0, input.limit ?? 200).join('\n')
            return { path: relative(request.cwd, target), text }
          },
        }))

        // 4 提交工具：结构化入口，参数由适配器再校验一遍。
        disposers.push(tools.register({
          name: request.submit.name,
          description: request.role === 'finder'
            ? '提交一条评审发现。trigger 是触发条件，outcome 是错误结果，两者必填。'
            : '提交一条核实意见。verdict 与 reproducesOnBase 必填。',
          parameters: request.submit.schema as Record<string, unknown>,
          output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: args => {
            if (items.length >= request.submit.max) {
              throw new Error(`已达本次上限 ${request.submit.max} 条`)
            }
            items.push(args as T)
            return { accepted: true, count: items.length }
          },
        }))
      }

      // 5 发提示词。来源必须是 user-rpc，否则消息会被静默丢弃。
      const message = {
        id: `dsh-review-${sessionId}`,
        role: 'user',
        content: [{ type: 'text', text: request.prompt }],
        source: { kind: 'user-rpc', rpcId: `dsh-review-${sessionId}` },
      }
      agent.followup(message)

      // 6 等待：running → idle，或超时/取消。
      const wait = await this.waitDone(agent, request, startedAt)
      ended = wait.ended
      if (wait.ended === 'budget' || wait.ended === 'error') {
        try { agent.cancel?.() } catch {}
      }
    } finally {
      for (const dispose of disposers) {
        try { if (typeof dispose === 'function') dispose() } catch {}
      }
    }

    return {
      sessionId,
      items,
      usage: {
        turns: this.options.turnCounter?.(sessionId) ?? 0,
        durationMs: Date.now() - startedAt,
      },
      ended,
    }
  }

  private async ensureAgent(
    sessionId: string,
    cwd: string,
    preset: string,
    request: AgentRunnerRequest<unknown>,
  ): Promise<AgentLike | undefined> {
    const resolved = await this.host.sessionController.resolveAgent(sessionId)
    let agent = 'agent' in resolved ? resolved.agent : undefined
    if (!agent) {
      const workspace = await this.host.workspaceRegistry.create(cwd)
      await this.host.sessionController.create({ sessionId, workspaceId: workspace.id, agentPreset: preset })
      const again = await this.host.sessionController.resolveAgent(sessionId)
      agent = 'agent' in again ? again.agent : undefined
    }
    if (!agent) return undefined
    try {
      await this.host.sessionController.rename?.({
        sessionId,
        title: `dsh-review ${request.role}/${request.profile}`,
      })
    } catch {}
    this.options.onSession?.({
      sessionId,
      role: request.role,
      profile: request.profile,
      title: `dsh-review ${request.role}/${request.profile}`,
    })
    if (this.options.decorate) await this.options.decorate(agent, request)
    return agent
  }

  private async waitDone(
    agent: AgentLike,
    request: AgentRunnerRequest<unknown>,
    startedAt: number,
  ): Promise<{ ended: 'done' | 'budget' | 'error' }> {
    const pollMs = this.options.pollMs ?? 500
    const deadline = startedAt + request.budget.maxMs
    let sawRunning = false
    while (Date.now() < deadline) {
      if (request.signal?.aborted) return { ended: 'error' }
      const status = agent.status
      if (status === 'running' || status === 'working' || status === 'busy') sawRunning = true
      if (sawRunning && status === 'idle') return { ended: 'done' }
      const turns = this.options.turnCounter?.(agent.id) ?? 0
      if (request.budget.maxTurns > 0 && turns >= request.budget.maxTurns) return { ended: 'budget' }
      await new Promise(resolveSleep => setTimeout(resolveSleep, pollMs))
    }
    return { ended: 'budget' }
  }
}
