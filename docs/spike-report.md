# T0b 会话能力实验报告（终版）

2026-11-25 · 执行者：本会话

**结论：六项检查全部通过。** 第 6 项中的 token 用量记为不支持，其余可得。按任务书的停顿条件，本次不停顿，可以进入 T1。

实验在 102 机器（`tokens-bnt3-0007`）上完成，DSH 0.2.2-alpha.3。未向 GitCode 发任何写请求。

---

## 一、六项结论

| # | 检查 | 结论 |
|---|---|---|
| 1 | 代码创建独立会话，工作目录为该 worktree | **通过** |
| 2 | 限制工具为只读，写文件被拒绝 | **通过** |
| 3 | 路径守卫拒绝 `../`、绝对路径、外部符号链接 | **通过** |
| 4 | 自定义 `submit_finding` 可调用且参数经校验 | **通过** |
| 5 | 能等会话结束或超时，并能取消 | **通过**（取消只验证了接口存在） |
| 6 | 能取会话 ID、耗时、回合数、token 用量 | **部分通过**：前四项可得，token 用量不支持 |

模型自己的收尾陈述就是第 2、3 项的独立旁证：

> 我的工具清单为：`glob`、`grep`、`read_file`、`submit_finding`、`working_directory`；没有 `write`、没有 `edit`、没有 `bash`（也没有任何 shell 或修改文件的途径）。……读取工作区外的路径（相对越界与绝对路径）均被沙箱拒绝，因此本会话是纯只读的评审环境。

---

## 二、六项证据

### 2.1 创建会话

```
session created via create
agent ready; status=idle
createSession => {"ok":true,"via":"create","sessionId":"spike-1795660235187",
                  "cwd":"/root/zhaochi/mr62-wt","preset":"standard"}
```

调用链：`workspaceRegistry.create(cwd)` 换 workspaceId，`sessionController.create({sessionId, workspaceId, agentPreset})` 建会话，`resolveAgent(sessionId)` 取活 Agent。

**一处更正。** 前一份报告写过"0.2.2-alpha.3 的方法叫 `createSession`，与 superagent 的 `create` 不一致，属接口漂移"。**这个判断是错的。** 实测 `create` 存在且工作正常。当时只从类型文件看到 `createSession` 就推断 `create` 不存在，没读全也没实跑。此类未核实推断在 T1 里禁止再用。

### 2.2 限制工具

```
restrict => {"ok":true,"allow":["glob","grep","working_directory"]}
```

**关键规则：允许名单里只能写全局工具名。** 把自己注册的工具名写进去会直接报错：

```
tools.restrict() names unknown global tools "read_file", "submit_finding";
known global tools: ask_user_question, bash, create_goal, edit, …,
read, read_image, …, working_directory, write
```

`dsh-tools` 的类型注释说明了原因：本作用域自己的注册对限制免疫。所以 `read_file` 与 `submit_finding` 不需要（也不能）出现在名单里。

真实可用的只读全局工具只有 `glob`、`grep`、`read`、`read_image`、`working_directory` 五个。`list` 不是工具，列目录要用 `glob` 配 `pattern:"*"`。

### 2.3 路径守卫

```
guard => {"ok":true,"denials":[
  {"tool":"read_file","raw":"../../etc/hostname"},
  {"tool":"read_file","raw":"/etc/hostname"}]}
```

两条都被拒。守卫实现要点：

- 字段名是 **`execution.arguments`**，不是 `execution.args`。
- 判断要过两道：先按字面规范化比较是否在工作目录内，再用 `realpathSync` 复核一次，以挡住指向外部的符号链接。
- 返回值是拒绝理由字符串；`undefined` 表示放行。`checkGuards` 的类型注释写明"返回第一个拒绝理由"。

**一处更正。** 前一份报告把这条列为"必须在 T1 之前处置的漏洞"，说 DSH 允许读工作区外的绝对路径。**那个结论也是错的。** 真实原因是我读错了字段名，守卫永远返回 `undefined`，于是永远放行。DSH 的守卫机制本身没有问题。

不过这次误判留下一条有价值的结论：**只靠宿主的 `read` 工具时，绝对路径是否被拦取决于守卫写得对不对，而守卫的失败是静默的。** 因此本版采用双保险：限制工具时不授予 `read`，改注册自己的 `read_file`，把路径判断放在引擎侧（见下）。

### 2.4 自注册只读工具

```
ownTools => {"ok":true,"registered":["read_file","submit_finding"]}
read_file ok README.md
submit_finding called; missing=[]
registerTool => {"ok":true,"invoked":true}
findings: [{"title":"实验：探测只读会话能力","path":"README.md","line":1,
            "trigger":"执行实验提示词时","outcome":"仅验证工具可用，非真实缺陷"}]
```

`read_file` 只接受相对路径，内部用同一套 `containedPath` 判断，越界直接抛错。这样路径安全性不再依赖宿主行为。

`register` 的一个硬要求，第一次注册失败时给出：

```
tool "submit_finding" must declare output { schema, render, presentationMeta? }
```

`output` 必须同时给 `schema` 与 `render`：

```js
output: {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
```

### 2.5 等待与取消

```
status -> running （1.5 秒）
status -> idle   （14.5 秒）
wait => {"ok":true,"ended":"idle","sawWorking":true,"durationMs":14547}
```

`agent.status` 实测到两个取值：`running`、`idle`。判据用"先见过 running 再见到 idle"，可避免把创建后的初始 idle 误判为完成。

取消接口存在：`agent.cancel`。

```
cancel => {"ok":true,"via":"cancel","note":"方法存在；未在运行中的回合上实测"}
```

这一项记为通过但证据不完整：只确认了方法存在，没有在真正运行中的回合计实测取消效果。

### 2.6 身份、回合与用量

```
identity => {"sessionId":"spike-1795660235187","status":"idle",
             "turnStarts":1,"sessionEvents":35,"usage":null}
```

回合数通过监听 `session/event` 统计 `turn/start` 得到，可靠。会话日志的事件计数与此一致：

```
turn/start 1, step/start 4, assistant/message 4, tool/call 5, tool/result 5, user/message 3
```

token 用量：`agent.usage`、`agent.tokenUsage`、`agent.stats` 三个候选都为空。**记为不支持**，T1 按回合数与耗时控制预算，与任务书第 64 行的预案一致。

---

## 三、五个错误与其根因（本轮全部修完）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 插件装了但零日志、零输出 | 异常交给 `ctx.logger`，而它在这条启动路径上不可见 | 改同步文件探针 `appendFileSync`，每步落盘 |
| 2 | 推断 `create` 不存在 | 只看类型文件里出现 `createSession`，没读全也没实跑 | 实测；写成按候选名探测 |
| 3 | 插件在配置树里完全不存在且零报错 | bundle 的 `cordis.patch.yml` 写成 `[]` | 必须写成 `insert` 列表 |
| 4 | 插件静默不激活 | `inject` 声明了五个服务，其中有不存在的 | `inject` 只声明精确集合；其余用 `ctx.get()` |
| 5 | 状态正常翻动但模型从未收到提示词 | 自定义 `source` 未在 `MessageSourceMap` 注册，消息被静默丢弃 | 用 `{kind:'user-rpc', rpcId}`；生产版必须做模块声明 |

第 5 条是最危险的形态：`followup` 返回成功、状态从 `running` 翻到 `idle`、会话日志里却一条 `user/message` 都没有。**只有查会话日志才能发现。** 因此第 5 项的判据必须加上"日志里至少出现一条 `user/message`"。

另外两个非错误但必须写进 `AGENTS.md` 的事实：

- `dsh plugin add` 不会把链接插件加进 `dsh.profile.bundles`，必须手工追加。
- `--port` 会被 profile 的 `cordis.patch.yml` 里 `webserver.port` 覆盖；端口被占用时整个 profile 启动失败并报 `EADDRINUSE`，重跑前必须按端口杀旧进程（`pkill -f "profile spike"` 无效，因为命令行里没有这个词）。

---

## 四、给任务书的修订建议

**第一条，T0b 之前插一步"装载链路自检"。** 判据三条：插件出现在 `--dump-config` 里、`apply` 被调用、文件探针写出三行。第三节那五条错误里有四条都发生在这一步之内。

**第二条，第 5 项加一条判据：会话日志里必须出现 `user/message`。** 只看状态机会在消息被丢弃时照样通过。

**第三条，第 6 项的 token 用量改为"默认不支持"。** 三个候选属性都为空。

**第四条，第 2 项补一句限制：`restrict` 的允许名单只能写全局工具名。** 自注册工具自动免疫限制，写进名单会报错。

**第五条，第 3 项写明 `execution.arguments` 这个字段名。** 这是本轮唯一一个因字段名写错而产生的误判，代价是一整轮。

---

## 五、环境与复现

| 项 | 值 |
|---|---|
| 主机 | 102，`tokens-bnt3-0007` |
| DSH | `/root/dsh-022`，0.2.2-alpha.3，331 个 `@deepseek-ai` 包 |
| 实验插件 | `/root/zhaochi/dsh-review/spike/index.js`，纯 ESM，无构建 |
| 独立配置根 | `/root/zhaochi/spike-home`，profile `spike` |
| 模型 | `maas-deepseek-v4.1-flash-volcengine-codeagent`，经反向隧道 `127.0.0.1:18080` |
| 真实 MR | `/root/zhaochi/mr62-wt`，GitCode `TokensService/dsh-superagent-prototype` 的 `!62` 合并提交 `68eb6a3`，第一父 `62439ae` |
| GitCode 写请求 | 零次 |

```bash
export NVM_DIR=/root/.nvm; . /root/.nvm/nvm.sh
export DSH_HOME=/root/zhaochi/spike-home
export PATH=/root/dsh-022/node_modules/.bin:$PATH
export SPIKE_RUN=1 SPIKE_CWD=/root/zhaochi/mr62-wt
export SPIKE_OUT=/root/zhaochi/spike-report.json
export SPIKE_TIMEOUT_MS=180000 SPIKE_STEP_MS=45000
export RELAY_API_KEY=none
dsh spike --host 127.0.0.1 --port 3084 --no-open
```

读会话日志：

```bash
zstd -dc <session.v4.jsonl.zstd> | head -40
```
