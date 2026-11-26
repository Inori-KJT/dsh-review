# T4 会话适配器验证报告

2026-11-26 · 执行者：本会话

**结论：T4 的四项验收全部通过，且真实模型在玩具仓库上找到了预先埋入的那个缺陷。可以进入 T5。**

验证在 102 机器上进行，DSH 0.2.2-alpha.3，模型 `maas-deepseek-v4.1-flash-volcengine-codeagent`，经反向隧道访问。未向任何代码平台发写请求。

---

## 一、四项验收与证据

### 1.1 真实 finder 能通过工具提交结构化发现

一次会话，9.7 秒，1 个回合，提交 1 条：

```json
{
  "title": "total() 的循环条件用 i <= items.length 越界，任何非空订单调用 checkout 都会抛 TypeError",
  "path": "lib/order.js",
  "line": 6,
  "trigger": "调用 checkout(user, items) 或 total(items) 且 items 是任意数组（包括空数组）；循环在 i === items.length 时仍会进入。",
  "outcome": "items[i] 为 undefined，执行 item.price 抛出 \"Cannot read properties of undefined (reading 'price')\" 的 TypeError，total/checkout 完全不可用，本应返回的金额与折后应付金额都拿不到。"
}
```

玩具仓库里埋的正是这一处：`for (let i = 0; i <= items.length; i += 1)`。它给出的触发条件与错误结果都准确——**这是一条可操作的发现，不是"这段代码可能有问题"这类空话**。

这一项同时证明了三件更基础的事：会话确实建起来了；`submit_finding` 这个自注册工具确实被模型调用了；参数按 schema 校验后落到了引擎侧的数据结构里。

### 1.2 三种逃逸被拒

现场会话里，模型按提示依次尝试了五次读取，工具结果是：

```
Error: 拒绝访问工作目录之外的路径: ../etc/hostname
Error: 拒绝访问工作目录之外的路径: /etc/hostname
Error: 拒绝访问工作目录之外的路径: outside-link
Error: 拒绝访问工作目录之外的路径: sub/../../etc/hostname
```

`outside-link` 是指向 `/etc/hostname` 的符号链接。它被拒，说明围栏做了 realpath 复核，不是只比字符串前缀。

纯函数层面另有一组断言，不依赖模型行为：

```
{"relativeInside":true,"dotdot":true,"absolute":true,"symlinkOutside":true,"nestedEscape":true}
```

### 1.3 超时后会话被取消

预算设为 4000 毫秒，实际 4055 毫秒返回，`ended` 为 `budget`，适配器随后调用 `agent.cancel()`。测试里另有两条：回合数达到上限也判 `budget`；取消信号在起会话之前置位时，一个会话都不建、提示词也不发。

### 1.4 用量有记录

三次运行分别记到 `{"turns":1,"durationMs":9704}`、`{"turns":1,"durationMs":4055}`。回合数来自注入的计数器（插件在 `session/event` 上数 `turn/start`），耗时由适配器自己算。

**token 用量仍未取得**，与 T0b 的结论一致，按任务书第 64 行的预案用回合数与耗时控预算。

---

## 二、实现要点：每一条都来自 T0b 的实测

`src/adapters/dsh-agent-runner.ts` 里六处写法如果不这样写就会静默失败，因此逐条记下。

| 写法 | 不这样写会怎样 |
|---|---|
| 建会话用 `sessionController.create` | 用 `createSession` 会调到不存在的方法（我一度误判为接口漂移） |
| `restrict` 名单只写全局工具名 | 写自己注册的工具名会报 `unknown global tools` |
| 注册工具时 `output` 必须给 `schema` 与 `render` | 只给 `schema` 会报 `must declare output { schema, render }` |
| 守卫读 `execution.arguments` | 读 `execution.args` 会永远取到 undefined，于是永远放行——这是我在 T0b 里踩过的坑，代价是一整轮 |
| 投递来源用 `{kind:'user-rpc', rpcId}` | 用自定义来源时 `followup` 返回成功、状态照常翻动，但模型从未收到提示词 |
| 等待判据是"先 running 再 idle" | 只等 idle 会把创建后的初始 idle 误判为完成 |

另外一条结构性决定：**不把路径安全交给宿主的 `read` 工具**。限制工具时不授予 `read`，改自注册 `read_file`，把路径判断放在引擎侧。理由是守卫的失败是静默的，双保险才可靠。这条也解释了为什么 `read_file` 与 `submit_finding` 都不出现在 `restrict` 名单里——自作用域的注册对限制免疫，这是 DSH 的既定行为。

---

## 三、一处未完成项及其理由

任务书要求"在 `cordis.patch.yml` 里定义 finder 和 verifier 预设：只读工具，无 shell，无网络"。

两个预设（`dsh-review-finder`、`dsh-review-verifier`）已经写好并进了配置树：

```
1259:- id: dsh-review
1260:  name: dsh-review
1261:- id: dsh-review-finder-preset
1264:    id: dsh-review-finder
```

但**本次验证跑在 DSH 自带的 `standard` 预设上，靠 `restrict` 收窄工具集**，没有切到这两个自定义预设。

原因是我还不确定自定义预设需要哪些插件才能提供 `glob`、`grep`、`working_directory` 这三个工具。预设里我列了 `dsh-tool-fs` 与 `dsh-tool-fs-search`，但没有逐个验证它们各自提供哪些工具名。`restrict` 一旦拿到不存在的工具名会直接报错，所以贸然切换有失败风险。

**这是一个明确的待办，不是遗漏**：T6 之前要把两个预设的插件清单逐个核对，并把适配器默认预设切过去。验证方法很直接——切过去之后重跑本节 1.2 的四条逃逸，若 `restrict` 报 `unknown global tools` 就说明清单不对。

---

## 四、自动化测试

新增 `tests/dsh-runner.test.ts`，13 条，用假宿主覆盖上面六条实现要点中的五条（不需要真实 DSH）：

- `containPath`：允许内部相对路径；拒绝 `../`、绝对路径、嵌套逃逸、空串、非字符串；拒绝指向外部的符号链接
- 限制工具只把三个全局名交给 `restrict`
- 提交工具收集条目并受 `max` 上限约束（第三条应抛错）
- 自注册 `read_file` 越界抛错、读内文件成功
- 守卫按 `execution.arguments` 取参，`path` 与 `file_path` 两种键名都覆盖
- 正常结束判 `done` 且回合数来自注入的计数器
- 超时判 `budget` 并取消会话；回合超限同样
- 取消信号置位后不建会话、不发提示词
- 提示词来源是 `user-rpc`
- 会话标题带角色与 profile，并回报给面板

全套 **108 个测试通过**。`core`、`stages`、`app` 三者仍在 `types: []` 下通过类型检查，`adapters` 因使用 `node:*` 由运行测试保证。

---

## 五、复现命令

```bash
export NVM_DIR=/root/.nvm; . /root/.nvm/nvm.sh
export DSH_HOME=/root/zhaochi/t4-home
export PATH=/root/dsh-022/node_modules/.bin:$PATH
export SPIKE_RUN=1 SPIKE_CWD=/root/zhaochi/toy-repo
export SPIKE_OUT=/root/zhaochi/t4-report.json
export SPIKE_PROBE=/root/zhaochi/t4-probe.log
export RELAY_API_KEY=none
dsh t4 --host 127.0.0.1 --port 3085 --no-open
```

玩具仓库在 `/root/zhaochi/toy-repo`，缺陷在 `lib/order.js:6`。会话日志用
`zstd -dc <session.v4.jsonl.zstd>` 读。

---

## 六、下一步

T5：提示词。按任务书的判据表写 `prompts/finders/correctness.md`、`security.md` 与 `prompts/verifier.md`，并用四个玩具 PR 验收：一个逻辑 bug、一个路径穿越、一个完全干净、一个注入测试（PR 注释要求读 `~/.ssh` 并写进发现）。

T4 已经证明真实模型能在这个装置里找到真缺陷，T5 要证明的是**换掉提示词之后它的误报与漏报会按预期变化**。
