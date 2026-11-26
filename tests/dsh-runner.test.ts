/**
 * T4 的单测：用假宿主验证 DshAgentRunner 的六条行为，不需要真实 DSH。
 *
 * 覆盖：路径围栏、限制工具的名单、提交工具收集、超时取消、取消信号、用量记录。
 * 真实 DSH 上的端到端验证在 docs/t4-report.md 里，两者互补：
 * 这里保证逻辑对，那里保证接口真的长这样。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DshAgentRunner, containPath, DEFAULT_READ_ONLY_TOOLS } from '../src/adapters/dsh-agent-runner.ts'
import type { AgentLike, SessionHost, ToolScope } from '../src/adapters/dsh-agent-runner.ts'

function tempTree(): string {
  const root = mkdtempSync(join(tmpdir(), 't4-'))
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'README.md'), '# demo\n')
  writeFileSync(join(root, 'lib', 'a.js'), 'module.exports = 1\n')
  try { symlinkSync('/etc/hostname', join(root, 'outside-link')) } catch {}
  return root
}

/** 一个可编排的假 Agent：状态由测试控制，工具调用被记录。 */
class FakeAgent implements AgentLike {
  readonly id: string
  status = 'idle'
  readonly session = { header: { cwd: '', agentPreset: 'standard' } }
  readonly restricted: string[] = []
  readonly registered: string[] = []
  readonly guards: Array<(execution: { name?: string; arguments?: unknown }) => string | undefined> = []
  readonly sent: unknown[] = []
  readonly registry = new Map<string, { execute: (args: unknown) => unknown }>()
  readonly tools: ToolScope = this.makeTools()
  /** 适配器读的是 agent.ctx.tools，所以假件必须把工具挂在 ctx 下。 */
  readonly ctx: { tools: ToolScope } = { tools: this.tools }
  cancelled = false
  goRunning = true

  constructor(id: string) {
    this.id = id
  }

  private makeTools(): ToolScope {
    const self = this
    return {
      restrict(filter) { self.restricted.push(...filter.allow); return () => {} },
      guard(fn) { self.guards.push(fn); return () => {} },
      register(tool) {
        self.registered.push(tool.name)
        self.registry.set(tool.name, { execute: tool.execute })
        return () => {}
      },
    }
  }

  followup(message: unknown): void {
    this.sent.push(message)
    if (this.goRunning) this.status = 'running'
  }

  cancel(): void {
    this.cancelled = true
    this.status = 'idle'
  }

  /** 模拟一轮结束。 */
  finish(): void { this.status = 'idle' }
}

function hostWith(agent: FakeAgent): SessionHost {
  return {
    sessionController: {
      async resolveAgent() { return { agent } },
      async create() { return {} },
      async rename() { return {} },
    },
    workspaceRegistry: { async create() { return { id: 'ws-1' } } },
  }
}

function request(cwd: string, overrides: Partial<Parameters<DshAgentRunner['run']>[0]> = {}) {
  return {
    role: 'finder' as const,
    profile: 'correctness',
    prompt: '请评审',
    cwd,
    readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
    submit: {
      name: 'submit_finding',
      schema: { type: 'object', properties: {} },
      max: 3,
    },
    budget: { maxTurns: 10, maxMs: 200 },
    ...overrides,
  }
}

function runner(agent: FakeAgent, overrides: Partial<ConstructorParameters<typeof DshAgentRunner>[1]> = {}) {
  const sessions: string[] = []
  const instance = new DshAgentRunner(hostWith(agent), {
    finderPreset: 'dsh-review-finder',
    verifierPreset: 'dsh-review-verifier',
    readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
    pollMs: 5,
    onSession: info => sessions.push(info.sessionId),
    ...overrides,
  })
  return { instance, sessions }
}

// ---------- 路径围栏 ----------

test('containPath：允许工作目录内的相对路径', () => {
  const root = tempTree()
  assert.ok(containPath(root, 'README.md'))
  assert.ok(containPath(root, 'lib/a.js'))
})

test('containPath：拒绝 ../、绝对路径、嵌套逃逸', () => {
  const root = tempTree()
  assert.equal(containPath(root, '../etc/hostname'), undefined)
  assert.equal(containPath(root, '/etc/hostname'), undefined)
  assert.equal(containPath(root, 'sub/../../etc/hostname'), undefined)
  assert.equal(containPath(root, ''), undefined)
  assert.equal(containPath(root, 42), undefined)
})

test('containPath：拒绝指向工作目录之外的符号链接', () => {
  const root = tempTree()
  // 字面上它在 root 内，但解析后指向 /etc/hostname。
  assert.equal(containPath(root, 'outside-link'), undefined)
})

// ---------- 限制工具 ----------

test('限制工具：只把全局工具名交给 restrict', async () => {
  const root = tempTree()
  const agent = new FakeAgent('s1')
  const { instance } = runner(agent)
  const promise = instance.run(request(root))
  agent.finish()
  await promise
  assert.deepEqual(agent.restricted, ['glob', 'grep', 'working_directory'],
    `restrict 收到了 ${JSON.stringify(agent.restricted)}`)
  // 自注册的工具不能出现在 restrict 名单里。
  assert.ok(!agent.restricted.includes('read_file'))
  assert.ok(!agent.restricted.includes('submit_finding'))
})

// ---------- 提交工具 ----------

test('提交工具：收集结构化条目，并受 max 上限约束', async () => {
  const root = tempTree()
  const agent = new FakeAgent('s2')
  const { instance } = runner(agent)
  const result = instance.run(request(root, { submit: { name: 'submit_finding', schema: { type: 'object', properties: {} }, max: 2 } }))

  // 等一个 poll 周期后，用注册进来的工具提交三条，第三条应被拒。
  await new Promise(resolveWait => setTimeout(resolveWait, 20))
  const submit = agent.registry.get('submit_finding')!
  submit.execute({ title: 'a' })
  submit.execute({ title: 'b' })
  assert.throws(() => submit.execute({ title: 'c' }), /上限/)

  agent.finish()
  const done = await result
  assert.equal(done.items.length, 2)
  assert.equal(done.ended, 'done')
})

test('自注册的 read_file 越界时抛错，读内文件成功', async () => {
  const root = tempTree()
  const agent = new FakeAgent('s3')
  const { instance } = runner(agent)
  const result = instance.run(request(root))
  await new Promise(resolveWait => setTimeout(resolveWait, 20))
  const readFile = agent.registry.get('read_file')!
  const ok = readFile.execute({ path: 'README.md' }) as { text: string }
  assert.match(ok.text, /# demo/)
  assert.throws(() => readFile.execute({ path: '../etc/hostname' }), /允许范围之外/)
  agent.finish()
  await result
})

test('守卫按 execution.arguments 取参并拒绝越界', async () => {
  const root = tempTree()
  const agent = new FakeAgent('s4')
  const { instance } = runner(agent)
  const result = instance.run(request(root))
  await new Promise(resolveWait => setTimeout(resolveWait, 20))
  const guard = agent.guards[0]
  // 字段名必须是 arguments，写成 args 会永远放行。
  assert.equal(guard({ name: 'read', arguments: { path: 'README.md' } }), undefined)
  assert.match(String(guard({ name: 'read', arguments: { path: '/etc/hostname' } })), /拒绝/)
  assert.match(String(guard({ name: 'read', arguments: { file_path: '../x' } })), /拒绝/)
  assert.match(String(guard({ name: 'read', arguments: { path: 'outside-link' } })), /拒绝/)
  agent.finish()
  await result
})

// ---------- 等待、超时、取消 ----------

test('正常结束：状态先 running 后 idle 即判 done，并记录用量', async () => {
  const root = tempTree()
  const agent = new FakeAgent('s5')
  const { instance } = runner(agent, { turnCounter: () => 3 })
  const promise = instance.run(request(root, { budget: { maxTurns: 30, maxMs: 2000 } }))
  await new Promise(resolveWait => setTimeout(resolveWait, 30))
  agent.finish()
  const result = await promise
  assert.equal(result.ended, 'done')
  assert.equal(result.usage.turns, 3, '回合数应来自注入的计数器')
  assert.ok(result.usage.durationMs > 0, '耗时应有记录')
})

test('超时：返回 budget 并取消会话', async () => {
  const root = tempTree()
  const agent = new FakeAgent('s6')
  const { instance } = runner(agent)
  const result = await instance.run(request(root, { budget: { maxTurns: 999, maxMs: 60 } }))
  assert.equal(result.ended, 'budget')
  assert.equal(agent.cancelled, true, '超时后应取消会话')
})

test('回合上限：达到 maxTurns 即判 budget', async () => {
  const root = tempTree()
  const agent = new FakeAgent('s7')
  const { instance } = runner(agent, { turnCounter: () => 99 })
  const result = await instance.run(request(root, { budget: { maxTurns: 5, maxMs: 2000 } }))
  assert.equal(result.ended, 'budget')
  assert.equal(agent.cancelled, true)
})

test('取消信号：置位后一个会话都不起', async () => {
  const root = tempTree()
  const agent = new FakeAgent('s8')
  const { instance, sessions } = runner(agent)
  const result = await instance.run(request(root, { signal: { aborted: true } }))
  assert.equal(result.ended, 'error')
  assert.equal(result.items.length, 0)
  assert.equal(sessions.length, 0, '取消后不应建立会话')
  assert.equal(agent.sent.length, 0, '取消后不应发送提示词')
})

test('提示词用 user-rpc 来源投递', async () => {
  const root = tempTree()
  const agent = new FakeAgent('s9')
  const { instance } = runner(agent)
  const promise = instance.run(request(root))
  await new Promise(resolveWait => setTimeout(resolveWait, 20))
  agent.finish()
  await promise
  const message = agent.sent[0] as { source?: { kind?: string } }
  assert.equal(message.source?.kind, 'user-rpc', '来源必须是 user-rpc，否则消息会被静默丢弃')
})

test('会话标题带角色与 profile，并回报给面板', async () => {
  const root = tempTree()
  const agent = new FakeAgent('s10')
  const { instance, sessions } = runner(agent)
  const promise = instance.run(request(root))
  await new Promise(resolveWait => setTimeout(resolveWait, 20))
  agent.finish()
  await promise
  assert.equal(sessions.length, 1)
  assert.match(sessions[0], /dsh-review-finder/)
})
