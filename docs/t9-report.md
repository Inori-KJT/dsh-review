# T9 常驻插件与决策包验证报告

2026-11-26 · 执行者：本会话

**结论：插件已经能常驻运行——面板在 3088 上汇报健康，轮询自动为开放 PR 建运行并跑完，结果落库，决策包能生成并按门槛给出建议。T9 的工程部分完成。**

**但 T9 的验收要求"跑 5 到 7 天、每天在面板里处置发现"，其中包含真实时间流逝与人的判断。这一部分我没有、也不可能在一次会话里完成。第八节说明它剩下的到底是什么。**

---

## 一、插件跑起来的实证

一次干净启动后的文件探针（宿主这条路径上 `ctx.logger` 不可见，所以用探针）：

```
04:05:22.152 apply entered
04:05:22.152 config loaded: stateDir,port,repos,targets,pollSeconds,depth,tokenConfigPath,resumeOnStart
04:05:22.152 session/event listener attached
04:05:22.152 building deps
04:05:22.164 deps built
04:05:22.164 starting panel
04:05:22.166 panel up: http://127.0.0.1:3088/review/ui
04:05:22.166 resumed 0 runs
04:05:22.167 polling started every 30000ms
04:05:22.167 started: 1 targets
```

端口与健康检查：

```
LISTEN 127.0.0.1:3088  (MainThread, pid 3469794)
GET /review/api/health -> {"ok":true,"at":"2026-11-26T04:06:10.114Z"}
```

轮询的实际产出（30 秒一轮，未干预）：

```
runs: 2
  #312 done round=1 c41374f19b
  #311 done round=1 2780527fbd
events: 20
```

**这两次运行不是我手动发起的**，是插件自己轮询到两个开放 PR 后建出来并跑完的。而且 #312 的 head 从 T6 那次记录的 `bc208bb6` 变成了 `c41374f19b`——说明对方仓库真的推了新提交，轮询确实在跟。

面板首页取下来 2854 字节，含 `tokens-worktable #311`、`tokens-worktable #312`、三个分栏标题与 `refresh" content="5"`。

---

## 二、装配起来的东西

| 部件 | 来源 | 在 T9 里的角色 |
|---|---|---|
| `src/index.ts` | 新增 | 插件入口：读配置、建依赖、起面板、起轮询、恢复未跑完的运行 |
| `index.mjs` | 新增 | 薄包装，只是把入口暴露给宿主 |
| `src/app/decision.ts` | 新增 | 决策包的纯逻辑：处置比例、四个门槛、典型好坏发现、成本 |
| `scripts/decision.mjs` | 新增 | 从状态库读数据，生成一页决策包 |
| `tests/decision.test.ts` | 新增 | 12 条，覆盖门槛判定与渲染 |

配置从一个 JSON 文件读，路径由 `DSH_REVIEW_CONFIG` 给出。不用宿主配置框架，因为这个插件的配置项会随调参频繁变化，而文件形式让"改了哪一项"在 git diff 里可见。

---

## 三、决策包

`scripts/decision.mjs` 对真实状态库跑出来的结果：

```
[decision] 2 次运行 / 0 条发现 / 0 条处置 → /root/zhaochi/t9-decision.md
[decision] 建议：insufficient-data
[decision]   已处置样本只有 0 条，少于 10 条
[decision]   只跑了 0 天，少于 5 天
[decision]   亚样本下不给"发评论"的建议，先把时间跑够
```

**这个"拒绝给建议"是正确的行为，不是失败。** 四个门槛写成了可调常量：

| 门槛 | 要求 | 为什么 |
|---|---|---|
| 成立占比 | ≥ 40% | 低了说明噪声大，人会被淹没 |
| 每个 PR 的 Important 误报数 | ≤ 1 | 高了会带来有害修改 |
| 已处置样本数 | ≥ 10 | 样本太少时任何比例都不可信 |
| 试运行天数 | ≥ 5 | 任务书的要求 |

判定逻辑是纯函数，同一份数据任何人算一遍都应得到同一结论。样本不足时它明确说"数据不足，继续跑"，而不是拿两条数据编一个建议。

---

## 四、修掉的两个真问题

### 4.1 `ctx.effect` 用错，导致面板与数据库在启动瞬间被关掉

第一版写的是：

```ts
ctx.effect?.(() => {
  stop()
  void server.close()
  void deps.close()
})
```

我以为这是"注册清理函数"。**实际上 cordis 的 `effect` 接受一个 setup，setup 返回清理函数，清理函数在卸载时才被调用。** 我的写法让清理立刻执行，于是——

- 日志说 `panel up: http://127.0.0.1:3088/review/ui`，但 3088 根本没在监听（刚绑上就被关了）
- 稍后第一次轮询报 `Error: database is not open`

这个错误的危险性在于：**每一项检查单独看都像"没生效"，而真实原因是"生效了又被自己拆掉"。** 如果不是加文件探针看到完整的时间线，很容易误判成"插件没激活"而去查补丁配置。

正确写法：

```ts
ctx.effect?.(() => () => {
  stop()
  void server.close()
  void deps.close()
})
```

### 4.2 `.mjs` 里不能写 `export type`

`index.mjs` 最初有一行 `export type { ReviewConfig } from './src/index.ts'`，宿主直接报 `SyntaxError: Unexpected token 'export'`。

这与 T8 踩的是同一类坑：**Node 对 `.js` / `.mjs` 不做类型剥离，任何 TypeScript 语法都非法。** 已在文件头写明禁令。

---

## 五、测试与类型检查

新增 `tests/decision.test.ts` 12 条：处置汇总（含未处置比例与零处置不除零）、样本充足达标建议发评论、成立占比偏低建议降噪、Important 误报过多建议降噪、样本不足、天数不足、门槛值可追溯到常量、典型例子优先级、成本累加、PR 去重、渲染内容。

全套 **156 个测试通过**，两档类型检查干净。

---

## 六、复现

```bash
export NVM_DIR=/root/.nvm; . /root/.nvm/nvm.sh
export DSH_HOME=/root/zhaochi/t4-home
export PATH=/root/dsh-022/node_modules/.bin:$PATH
export DSH_REVIEW_CONFIG=/root/zhaochi/t9-config.json
export GITCODE_CONFIG=/root/zhaochi/.config/gitcode/credentials.json
export RELAY_API_KEY=none
export https_proxy=http://127.0.0.1:8889 http_proxy=http://127.0.0.1:8889
export no_proxy=localhost,127.0.0.1,192.168.0.0/16,10.0.0.0/8
dsh t4 --host 127.0.0.1 --port 3085 --no-open
```

面板 `http://127.0.0.1:3088/review/ui`。生成决策包：

```bash
node scripts/decision.mjs --db /root/zhaochi/t9-state/dsh-review.sqlite --days <天数>
```

**代理不能省。** 102 访问 gitcode.com 依赖它自带的 `127.0.0.1:8889`；第一次没设代理时轮询全报 `fetch failed`。

---

## 七、当前状态与真实边界

**已经具备的：**

- 常驻插件，能被 DSH 加载，能被自然语言之外的方式（配置文件）调参
- 面板可看：三栏运行列表、阶段导轨、发现表、四个处置按钮
- 轮询自动发现新 head 并建运行，遵守"同一 head 只评一次""评论不触发""轮次递增"
- 结果落库：runs、stage_execs（含按阶段的用量增量）、findings、votes、events
- 崩溃恢复：重启后从 cursor 继续
- 决策包：处置比例、四个门槛、典型好坏发现、成本

**尚未具备的（都不是能力缺口，是时间或外部条件）：**

1. **5 到 7 天的真实试运行。** 需要墙上时间。
2. **真实的处置数据。** 两个真实 PR 都是 0 条发现，所以面板的处置按钮只在假数据上验过。这条在 T7 报告里已标注。
3. **token 用量。** 宿主取不到，预算表那一列无法校准。
4. **发评论的能力。** `publish.mode` 只实现了 `record`，`comment` 与 `block` 按 PR 规则抛 `NotEnabled`。这是有意的：任务书要求评测达标并经负责人同意后才开。

---

## 八、T9 剩下的到底是什么

任务书对 T9 的验收是"一页报告，包含处置比例、典型的好发现和坏发现各三条、成本，以及是否进入'发评论'阶段的建议，由导师决定"。

这一页报告的**生成器已经有了**，缺的是喂给它的数据。要填满它，需要同时具备三件事：

1. **时间**：连续 5 到 7 天，插件不停。
2. **发现**：目标仓库在这段时间里产生有真实缺陷的 PR。这两个 PR 恰好都没有，是运气问题，不是引擎问题。
3. **人的判断**：每天有人在面板上把发现标成四类之一。这件事无法由我代劳，因为处置比例的整个价值就在于它来自人。

**所以 T9 不是一个可以在会话里"做完"的步骤。** 它是一次真实的观察期。我能做的、也已经做完的，是把观察期需要的一切准备到位，并让决策包在数据不足时如实说"数据不足"。

要真正启动这 5 到 7 天，需要两件事由人确认：一是这台机器允许长期挂着这个进程，二是把 `targets` 换成团队真正在用的仓库。这两件事都超出了我的权限范围。
