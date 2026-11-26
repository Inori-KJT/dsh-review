/**
 * T4 验证装置。只做四件事，做完把证据写进 SPIKE_OUT：
 *   1 真实 finder 能通过 submit 工具提交结构化发现
 *   2 `../`、绝对路径、指向 worktree 外的符号链接三种逃逸都被拒
 *   3 超时后会话被取消，运行如实报告 ended=budget
 *   4 用量（回合数、耗时）有记录
 *
 * 它不进主代码，只用来证明 src/adapters/dsh-agent-runner.ts 在真实 DSH 上成立。
 */
import { appendFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DshAgentRunner, containPath } from '../../src/adapters/dsh-agent-runner.ts'

const PROBE = process.env.SPIKE_PROBE || '/root/zhaochi/t4-probe.log'
const started = Date.now()
const turnCounts = new Map()

function probe(message) {
  try { appendFileSync(PROBE, `${new Date().toISOString()} +${Date.now() - started}ms ${message}\n`) } catch {}
  try { process.stderr.write(`[t4] ${message}\n`) } catch {}
}

probe('module loaded')
export const name = 'dsh-review-t4-spike'
export const inject = ['sessionController', 'workspaceRegistry']

export function apply(ctx) {
  probe(`apply; SPIKE_RUN=${process.env.SPIKE_RUN ?? 'unset'}`)
  try {
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/start') return
      const id = String(session?.id ?? session?.header?.id ?? '')
      turnCounts.set(id, (turnCounts.get(id) ?? 0) + 1)
    })
    probe('turn counter attached')
  } catch (error) {
    probe(`turn counter failed: ${error?.message ?? error}`)
  }
  if (process.env.SPIKE_RUN !== '1') return
  Promise.resolve().then(() => run(ctx)).catch(error => probe(`run rejected: ${error?.stack ?? error}`))
}

const FINDER_PROMPT = (cwd) => [
  `你在 ${cwd} 做只读代码评审。工作方式：先用 glob 看目录，再用 read_file 读文件。`,
  '你要提交恰好一条发现，用 submit_finding。五个字段必填：',
  '  title 一句话结论；path 相对路径；line 行号；',
  '  trigger 触发条件（什么输入或状态会走到这里）；outcome 错误结果（会发生什么）。',
  '读 README.md 与 lib 下的代码，找出真实缺陷后提交。不要臆测。',
].join('\n')

const ESCAPE_PROMPT = (cwd) => [
  `你在 ${cwd}。请依次尝试下面五次读取，每次都用 read_file，把报错原话抄下来：`,
  '1. path = "README.md"（应当成功）',
  '2. path = "../etc/hostname"（应当被拒）',
  '3. path = "/etc/hostname"（应当被拒）',
  '4. path = "outside-link"（这是一个指向工作目录之外的符号链接，应当被拒）',
  '5. path = "sub/../../etc/hostname"（应当被拒）',
  '五次都做完后，用一句话总结哪些被拒、哪些成功。',
].join('\n')

async function run(ctx) {
  const out = process.env.SPIKE_OUT || '/root/zhaochi/t4-report.json'
  const cwd = process.env.SPIKE_CWD || '/root/zhaochi/toy-repo'
  const report = { at: new Date().toISOString(), cwd, checks: {}, errors: [] }
  const save = () => {
    try { mkdirSync(dirname(out), { recursive: true }) } catch {}
    try { writeFileSync(out, JSON.stringify(report, null, 2), 'utf8') } catch {}
  }
  save()
  probe(`run entered; cwd=${cwd}`)

  try {
    // 准备一个指向工作目录之外的符号链接，用来测第三种逃逸。
    const outsideLink = join(cwd, 'outside-link')
    try { rmSync(outsideLink, { force: true }) } catch {}
    try { symlinkSync('/etc/hostname', outsideLink) } catch (error) { probe(`symlink failed: ${error?.message}`) }

    // 先做纯函数层面的围栏检查，不受模型行为影响。
    const symlinkCase = containPath(cwd, 'outside-link')
    report.checks.containPath = {
      relativeInside: containPath(cwd, 'README.md') !== undefined,
      dotdot: containPath(cwd, '../etc/hostname') === undefined,
      absolute: containPath(cwd, '/etc/hostname') === undefined,
      symlinkOutside: symlinkCase === undefined,
      nestedEscape: containPath(cwd, 'sub/../../etc/hostname') === undefined,
    }
    save()
    probe(`containPath: ${JSON.stringify(report.checks.containPath)}`)

    const runner = new DshAgentRunner(
      { sessionController: ctx.sessionController, workspaceRegistry: ctx.workspaceRegistry },
      {
        finderPreset: process.env.SPIKE_FINDER_PRESET || 'standard',
        verifierPreset: process.env.SPIKE_VERIFIER_PRESET || 'standard',
        readOnlyTools: ['glob', 'grep', 'working_directory'],
        pollMs: 500,
        turnCounter: sessionId => turnCounts.get(sessionId) ?? 0,
        onSession: info => probe(`session ${info.sessionId} for ${info.role}/${info.profile}`),
      },
    )

    // ---- 检查 1 与 4：真实 finder 提交发现，并记录用量 ----
    const finder = await runner.run({
      role: 'finder',
      profile: 'correctness',
      prompt: FINDER_PROMPT(cwd),
      cwd,
      readOnlyTools: ['glob', 'grep', 'working_directory'],
      submit: {
        name: 'submit_finding',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'path', 'line', 'trigger', 'outcome'],
          properties: {
            title: { type: 'string' },
            path: { type: 'string' },
            line: { type: 'integer' },
            trigger: { type: 'string' },
            outcome: { type: 'string' },
          },
        },
        max: 4,
      },
      budget: { maxTurns: 30, maxMs: 120000 },
    })
    report.checks.finder = { sessionId: finder.sessionId, ended: finder.ended, usage: finder.usage, items: finder.items }
    save()
    probe(`finder ended=${finder.ended} items=${finder.items.length} usage=${JSON.stringify(finder.usage)}`)

    // ---- 检查 2：三种逃逸在现场被拒 ----
    const escape = await runner.run({
      role: 'finder',
      profile: 'escape-test',
      prompt: ESCAPE_PROMPT(cwd),
      cwd,
      readOnlyTools: ['glob', 'grep', 'working_directory'],
      submit: { name: 'submit_finding', schema: { type: 'object', properties: {} }, max: 1 },
      budget: { maxTurns: 20, maxMs: 90000 },
    })
    report.checks.escapeSession = { sessionId: escape.sessionId, ended: escape.ended, usage: escape.usage }
    save()
    probe(`escape session ended=${escape.ended}`)

    // ---- 检查 3：超时后会话被取消 ----
    const timed = await runner.run({
      role: 'finder',
      profile: 'timeout-test',
      prompt: '请尽可能详细地分析这个仓库，逐文件读完再总结。',
      cwd,
      readOnlyTools: ['glob', 'grep', 'working_directory'],
      submit: { name: 'submit_finding', schema: { type: 'object', properties: {} }, max: 1 },
      budget: { maxTurns: 999, maxMs: 4000 },
    })
    report.checks.timeout = { sessionId: timed.sessionId, ended: timed.ended, usage: timed.usage }
    save()
    probe(`timeout run ended=${timed.ended} (期望 budget)`)
  } catch (error) {
    report.errors.push(String(error?.stack ?? error))
    probe(`run error: ${error?.message ?? error}`)
    save()
  } finally {
    save()
    probe(`report at ${out}`)
  }
}
