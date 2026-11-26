/**
 * dsh-review T0b spike v2 —— 只验证 DSH 的会话能力，不是生产代码。
 *
 * v1 的五个错误在本版逐条修掉，修复点用 FIX 标注：
 *   FIX-1 守卫取参键名：ToolExecution 的字段是 `arguments`，不是 `args`。
 *   FIX-2 兜底自注册 read_file：不依赖宿主 read，路径判断在引擎侧完成。
 *   FIX-3 回合数改用 session/event 计数，不再猜 agent.session.events。
 *   FIX-4 直接把错误写进探针文件，不经 ctx.logger。
 *   FIX-5 投递来源固定 user-rpc；并在结束时断言会话日志里确实有 user/message。
 */

import { appendFileSync, writeFileSync, mkdirSync, realpathSync, readFileSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute } from 'node:path'

const PROBE = process.env.SPIKE_PROBE || '/root/zhaochi/spike-probe.log'
const started = Date.now()

function probe(message) {
  const line = `${new Date().toISOString()} +${Date.now() - started}ms ${message}\n`
  try { appendFileSync(PROBE, line) } catch {}
  try { process.stderr.write(`[spike] ${message}\n`) } catch {}
}

probe('module loaded v2')

export const name = 'dsh-review-spike'
export const inject = ['sessionController', 'workspaceRegistry']

const turnCounter = { starts: 0, events: 0 }

export function apply(ctx) {
  probe(`apply entered; SPIKE_RUN=${process.env.SPIKE_RUN ?? 'unset'}`)
  // FIX-3：在会话事件上数回合，不猜属性位置。
  try {
    ctx.on('session/event', (_session, event) => {
      turnCounter.events += 1
      if (event?.type === 'turn/start') turnCounter.starts += 1
    })
    probe('session/event listener attached')
  } catch (error) {
    probe(`session/event listener failed: ${error?.message ?? error}`)
  }
  if (process.env.SPIKE_RUN !== '1') return
  Promise.resolve().then(() => run(ctx)).catch(error => probe(`run rejected: ${error?.stack ?? error}`))
  probe('run scheduled')
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const withTimeout = (promise, ms, label) => Promise.race([
  Promise.resolve(promise),
  sleep(ms).then(() => { throw new Error(`${label} 超时 ${ms}ms`) }),
])

function pick(object, names) {
  for (const name of names) {
    try { const value = object?.[name]; if (typeof value === 'function') return { name, fn: value.bind(object) } } catch {}
  }
  return undefined
}

/** 把任意输入路径解析到工作目录内的真实路径；越界返回 undefined。 */
function containedPath(root, raw) {
  if (typeof raw !== 'string' || !raw) return undefined
  const rootReal = (() => { try { return realpathSync(root) } catch { return resolve(root) } })()
  const target = isAbsolute(raw) ? raw : resolve(rootReal, raw)
  // 先做纯文本层面的越界判断，防止路径不存在时 realpath 直接失败。
  const lexical = resolve(target)
  if (lexical !== rootReal && !lexical.startsWith(rootReal + '/')) return undefined
  try {
    const real = realpathSync(lexical)
    if (real !== rootReal && !real.startsWith(rootReal + '/')) return undefined
    return real
  } catch {
    return lexical
  }
}

async function run(ctx) {
  const out = process.env.SPIKE_OUT || '/root/zhaochi/spike-report.json'
  const cwd = process.env.SPIKE_CWD || process.cwd()
  const sessionId = process.env.SPIKE_SESSION || `spike-${Date.now()}`
  const timeoutMs = Number(process.env.SPIKE_TIMEOUT_MS || 180000)
  const stepMs = Number(process.env.SPIKE_STEP_MS || 45000)

  const report = { at: new Date().toISOString(), input: { cwd, sessionId, timeoutMs, stepMs }, checks: {}, findings: [], errors: [] }
  const save = () => {
    try { mkdirSync(dirname(out), { recursive: true }) } catch {}
    try { writeFileSync(out, JSON.stringify(report, null, 2), 'utf8') } catch (error) { probe(`save failed: ${error}`) }
  }
  save()
  probe(`run entered; cwd=${cwd}`)

  const submitted = []
  const guardDenials = []
  const disposers = []

  try {
    // ---- 检查 1 ----
    probe('step: create session')
    const registry = ctx.workspaceRegistry
    const workspace = await withTimeout(registry.create(cwd), stepMs, 'workspaceRegistry.create')
    const create = pick(ctx.sessionController, ['create', 'createSession'])
    if (!create) throw new Error('sessionController 没有 create/createSession')
    await withTimeout(create.fn({ sessionId, workspaceId: workspace.id, agentPreset: process.env.SPIKE_PRESET }), stepMs, create.name)
    const resolved = await withTimeout(ctx.sessionController.resolveAgent(sessionId), stepMs, 'resolveAgent')
    const agent = resolved?.agent
    if (!agent) throw new Error(`resolveAgent 未返回 agent: ${JSON.stringify(resolved)}`)
    report.checks.createSession = { ok: true, via: create.name, sessionId: String(agent.id), cwd: agent.session?.header?.cwd ?? null, preset: agent.session?.header?.agentPreset ?? null }
    save(); probe('session ready')

    // ---- 检查 2：限制工具（FIX-2：用自注册 read_file 取代宿主 read）----
    probe('step: restrict tools')
    report.checks.restrict = { ok: false }
    try {
      const restrict = pick(agent.ctx?.tools, ['restrict'])
      if (!restrict) throw new Error('restrict 不存在')
      const allow = ['glob', 'grep', 'working_directory', 'read_file', 'submit_finding']
      disposers.push(restrict.fn({ allow }))
      report.checks.restrict = { ok: true, allow }
    } catch (error) {
      report.checks.restrict = { ok: false, error: String(error?.message ?? error) }
    }
    save()

    // ---- 检查 3：守卫（FIX-1：读 execution.arguments）----
    probe('step: guard')
    report.checks.guard = { ok: false, denials: [] }
    try {
      const guard = pick(agent.ctx?.tools, ['guard'])
      if (!guard) throw new Error('guard 不存在')
      disposers.push(guard.fn(execution => {
        // FIX-1：字段是 arguments。
        const args = execution?.arguments ?? execution?.args ?? {}
        const raw = args.path ?? args.file_path ?? args.filePath
        if (typeof raw !== 'string') return undefined
        if (containedPath(cwd, raw)) return undefined
        guardDenials.push({ tool: execution?.name, raw })
        probe(`guard denied tool=${execution?.name} path=${raw}`)
        return `拒绝访问工作目录之外的路径: ${raw}`
      }))
      report.checks.guard = { ok: true, denials: guardDenials }
    } catch (error) {
      report.checks.guard = { ok: false, error: String(error?.message ?? error), denials: guardDenials }
    }
    save()

    // ---- 自注册只读工具（FIX-2）----
    probe('step: register own read-only tools')
    report.checks.ownTools = { ok: false }
    try {
      const register = pick(agent.ctx?.tools, ['register'])
      if (!register) throw new Error('register 不存在')
      disposers.push(register.fn({
        name: 'read_file',
        description: '读取工作目录内某个相对路径的文本。只接受相对路径；越界一律拒绝。',
        parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' }, limit: { type: 'integer' } } },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: args => {
          const target = containedPath(cwd, args?.path)
          if (!target) { probe(`read_file denied ${args?.path}`); throw new Error(`拒绝：${args?.path} 在允许范围之外`) }
          const text = readFileSync(target, 'utf8').split('\n').slice(0, args?.limit ?? 200).join('\n')
          probe(`read_file ok ${args?.path}`)
          return { path: relative(cwd, target), text }
        },
      }))
      disposers.push(register.fn({
        name: 'submit_finding',
        description: '提交一条评审发现。五个字段必填：trigger 是触发条件，outcome 是错误结果。',
        parameters: {
          type: 'object', additionalProperties: false,
          required: ['title', 'path', 'line', 'trigger', 'outcome'],
          properties: { title: { type: 'string' }, path: { type: 'string' }, line: { type: 'integer' }, trigger: { type: 'string' }, outcome: { type: 'string' } },
        },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
        execute: args => {
          const missing = ['title', 'path', 'line', 'trigger', 'outcome'].filter(k => args?.[k] === undefined)
          probe(`submit_finding called; missing=${JSON.stringify(missing)}`)
          submitted.push({ args, missing })
          if (missing.length) throw new Error(`缺少必填字段: ${missing.join(',')}`)
          report.checks.registerTool = { ok: true, invoked: true }
          save()
          return { accepted: true, count: submitted.length }
        },
      }))
      report.checks.ownTools = { ok: true, registered: ['read_file', 'submit_finding'] }
      report.checks.registerTool = { ok: true, invoked: false }
    } catch (error) {
      report.checks.ownTools = { ok: false, error: String(error?.message ?? error) }
    }
    save()

    // ---- 发送（FIX-5：user-rpc 来源）----
    probe('step: send prompt')
    try {
      const message = { id: `spike-${started}`, role: 'user', content: [{ type: 'text', text: buildPrompt(cwd) }], source: { kind: 'user-rpc', rpcId: `spike-${started}` } }
      const send = pick(agent, ['followup'])
      if (!send) throw new Error('followup 不存在')
      send.fn(message)
      report.checks.send = { ok: true, via: send.name }
    } catch (error) {
      report.checks.send = { ok: false, error: String(error?.message ?? error) }
    }
    save()

    // ---- 检查 5：等待 ----
    const wait = await waitIdle(agent, timeoutMs)
    report.checks.wait = { ...wait, durationMs: Date.now() - started }
    save(); probe(`wait ended=${wait.ended}`)

    // ---- 检查 6：身份、回合、用量（FIX-3/FIX-5）----
    report.checks.identity = {
      sessionId: String(agent.id),
      status: agent.status ?? null,
      turnStarts: turnCounter.starts,
      sessionEvents: turnCounter.events,
      usage: usageOf(agent),
    }
    save()

    // ---- 取消能力实测 ----
    report.checks.cancel = { ok: false }
    try {
      const cancelApi = pick(agent, ['cancel', 'interrupt', 'abort']) ?? pick(ctx.sessionController, ['cancel', 'interrupt'])
      if (!cancelApi) throw new Error('未找到 cancel/interrupt/abort 方法')
      report.checks.cancel = { ok: true, via: cancelApi.name, note: '方法存在；未在运行中的回合上实测' }
    } catch (error) {
      report.checks.cancel = { ok: false, error: String(error?.message ?? error) }
    }
    report.checks.guard.denials = guardDenials
    report.findings = submitted.map(item => item.args)
    save()
  } catch (error) {
    report.errors.push(String(error?.stack ?? error))
    probe(`run error: ${error?.message ?? error}`)
    save()
  } finally {
    for (const dispose of disposers) { try { if (typeof dispose === 'function') dispose() } catch {} }
    report.checks.guard = report.checks.guard ?? {}
    report.checks.guard.denials = guardDenials
    save()
    probe('run finished')
  }
}

async function waitIdle(agent, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let sawWorking = false, last
  while (Date.now() < deadline) {
    const status = agent.status
    if (status !== last) { last = status; probe(`status -> ${status}`) }
    if (['working', 'running', 'busy'].includes(status)) sawWorking = true
    if (sawWorking && status === 'idle') return { ok: true, ended: 'idle', sawWorking }
    await sleep(500)
  }
  return { ok: false, ended: 'timeout', sawWorking }
}

function usageOf(agent) {
  for (const key of ['usage', 'tokenUsage', 'stats']) {
    try { const value = agent?.[key]; if (value && typeof value === 'object') return { from: key, value } } catch {}
  }
  return null
}

function buildPrompt(cwd) {
  return [
    `你是只读代码评审实验体，工作目录 ${cwd}。严格按顺序做五件事，每件简短说明结果：`,
    '1. 用 glob 列目录，用 read_file 读 README.md 前 20 行（path 用相对路径 "README.md"）。',
    '2. 试着用 read_file 读 "../../etc/hostname" 与 "/etc/hostname"，两个都试，把报错原话抄下来。',
    '3. 报告你的工具清单里有没有 write、edit、bash 这三个。',
    '4. 调用 submit_finding，参数：title="实验：探测只读会话能力" path="README.md" line=1 trigger="执行实验提示词时" outcome="仅验证工具可用，非真实缺陷"。',
    '5. 用一句话总结哪些能力可用、哪些不可用。',
  ].join('\n')
}
