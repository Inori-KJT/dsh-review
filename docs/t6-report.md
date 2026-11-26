# T6 GitCode 只读适配、触发与 CLI 验证报告

2026-11-26 · 执行者：本会话

**结论：四项验收全部通过，且跑的是真实 GitCode 仓库的真实 PR。这是任务书里"第一个可运行系统"的里程碑。**

**但有一条必须记下的代价：Standard 档在一个真实 PR 上跑了 6 分 16 秒，产出 0 条发现。** 详见第四节。

---

## 一、新增的四个文件

| 文件 | 作用 |
|---|---|
| `src/adapters/gitcode-forge.ts` | 只读 ForgePort：列 PR、读 PR、读评论、读可合并状态；三个写方法一律抛 `NotEnabled` |
| `src/adapters/git-cli.ts` | VcsPort：`git diff --unified=0` 解析 hunk、按 sha 读文件、建只读 worktree、清理 |
| `src/app/trigger.ts` | 轮询触发：只比较 head，算轮次与 since |
| `src/app/cli.ts` | 组合根与 `run` / `trigger` 入口，供脚本与将来的 HTTP 接口共用 |

---

## 二、四项验收与证据

验收对象是真实仓库 `TokensService/tokens-worktable` 的两个开放 PR。

### 2.1 对一个真实 PR 跑通 Standard，结果落库

```
开放 PR 2 个: #312,#311
target: pr=312  base=72f30d3047cc997d53793ad3be611ce2149aaf65
                head=bc208bb6770b7277518265fad3731a36050d960a
standardRun: {"runId":"run-0001-...","reused":false,"status":"done"}
standardDetail: {"status":"done","findings":0,"eventCount":11,"headSha":"bc208bb677"}
```

`status=done`、11 条事件、head sha 正确落库。PR 元数据（base/head/标题）来自 GitCode 的 `/repos/{repo}/pulls` 接口，worktree 由 `git worktree add --detach` 按 sha 建出，评审通过真实的 DSH 会话完成。

### 2.2 PR 新推一次后自动触发第 2 轮增量评审

```
新 head 轮询: [
  {"pr":312,"round":2,"since":"bc208bb677","runId":"run-0003-..."},
  {"pr":311,"round":2,"since":"2780527fbd","runId":"run-0004-..."}
]
```

两个 PR 各自算自己的轮次：`round` 递增为 2，`since` 精确等于该 PR 上一轮的 head。这正是"增量重审只看上次评审以来的差异"所需要的输入。

**这里要标明验证方式**：我没有向对方仓库推送代码，而是用一层可控的 Forge 包装，把 `listPulls` 返回的 head 换成一个真实存在的另一个提交（PR 的 base sha）。触发逻辑收到的输入与真实新推送完全一样，但仓库本身没有被改动。

### 2.3 在 PR 下发一条评论，不触发任何运行

```
评论轮询: submitted=0 runs 4 -> 4
```

而且这不是"评论被判为不重要"，是**结构上不可能**：`PollingTrigger.pollOnce` 根本不调用 `listComments`。单测里对此有断言：

```
assert.equal(forge.commentReads, 0, '触发器不应读取评论，这是结构上的保证')
```

这比"读了评论然后判定不触发"更强——过滤器可能写错，不读就不会错。

### 2.4 同一个 head 重复轮询不重复建运行

```
同 head 轮询: submitted=1 unchanged=1
```

`unchanged=1` 是那个已评审过的 PR #312（head 未变，跳过）。`submitted=1` 是 PR #311——它此前从未被评审，所以这是首次提交，符合预期。

---

## 三、附带修掉的两个缺口

### 3.1 `stage_execs` 一直是空的

第一次跑完后发现 `stages: []`。原因是 `Scheduler` 的 `afterStage` 只写了事件，没有调 `store.recordStage`。设计文档里这张表是"一个阶段每次尝试一行，重跑就是新增 attempt"，而它从未被写过。

已补：`afterStage` 现在同时写 `stage_execs` 与事件，attempt 按已有记录递增，重跑不覆盖旧行。

**这个缺口是验收时靠"去看表里有没有东西"发现的，不是靠测试。** 说明"结果落库"这一条要具体到每一张表，不能只看运行状态。

### 3.2 自定义预设缺一个必填配置

第一次运行直接失败：

```
tool-fs-search (@deepseek-ai/dsh-tool-fs-search): invalid config:
  - $.sampleOverCapGlobResults missing required value
```

补上 `sampleOverCapGlobResults: false` 后正常。

**顺带解决了 T4 与 T5 的遗留项。** 这两步当时跑在 DSH 自带的 `standard` 预设上，自定义预设只是写好了没用。T6 的 `buildDeps` 直接指定 `dsh-review-finder` 与 `dsh-review-verifier`，因此**本次验证确实跑在自定义预设上**——预设只含 `persona`、`tool-fs`、`tool-fs-search` 三组插件，没有 shell、没有网络、没有写文件工具。这条遗留可以关闭。

---

## 四、必须记下的代价：6 分 16 秒，0 条发现

Standard 档从 03:22:04 跑到 03:28:21，共 376 秒，产出 0 条发现。

两个可能的原因，我无法从现有数据区分：

1. **这个 PR 确实没有可报的缺陷。** PR #312 是"安装 EMS 时应用 SSD 和 RoCE 参数"，属于配置与脚本调整，correctness 与 security 两个 finder 都没找到符合判据的问题。
2. **告警没打开、或者 diff 太大导致模型没读到关键部分。** 我没有记录 `collect` 阶段的 `changedFiles` 与 `changedLines`，因此不知道这次评审覆盖了多少文件。

**第二点是我该在 T6 补上却没补的观测。** 预算表写着 Standard 档 25 分钟、6 个会话、120 万 token，本次 376 秒没有超时，但我不知道用了几个会话、消耗多少 token，因为 `stage_execs.usage` 里的 `sessions` 记的是累计值，`turns` 一直是 0（`runPipeline` 的 `finish()` 把 turns 写死为 0）。

这几处要并入 T8 的度量工作：`runs.usage` 与 `stage_execs.usage` 必须反映真实用量，否则预算表无从校准。

---

## 五、自动化测试

新增 `tests/trigger.test.ts`，12 条：

- 触发器：head 未变不建运行；head 变化建第 2 轮且 since 等于上一轮 head；首次见到的 PR 是第 1 轮无 since；评论不建运行且从读不到评论；多 PR 各自独立计轮次；熔断被拦下时不报成已提交
- 适配器：`listPulls` 解析 head/base/author 且令牌只进查询参数；`getPull` 返回标题与描述；404 返回 undefined 而不抛错；`readMergeable` 读两个字段；三个写方法一律抛 `NotEnabled`；没有令牌时给出明确错误而不发匿名请求

全套 **120 个测试通过**。

类型检查分两档：

- `tsconfig.json`（含 adapters 与 tests，`types: ["node"]`）——全量通过。为此新增 `typescript` 与 `@types/node` 两个开发依赖。
- `tsconfig.pure.json`（只有 `src/core` 与 `src/stages`，`types: []`）——通过。这一档保留它，是因为它是"领域逻辑不依赖任何运行时"的唯一证明，不能因为全量检查通了就删掉。

---

## 六、复现

```bash
export NVM_DIR=/root/.nvm; . /root/.nvm/nvm.sh
export DSH_HOME=/root/zhaochi/t4-home
export PATH=/root/dsh-022/node_modules/.bin:$PATH
export SPIKE_RUN=1 SPIKE_OUT=/root/zhaochi/t6-report.json
export SPIKE_REPO_PATH=/root/zhaochi/t6-work      # TokensService/tokens-worktable 的 blobless 克隆
export SPIKE_STATE=/root/zhaochi/t6-state.db
export SPIKE_REPO=TokensService/tokens-worktable
export GITCODE_CONFIG=/root/zhaochi/.config/gitcode/credentials.json   # 0600
export RELAY_API_KEY=none
dsh t4 --host 127.0.0.1 --port 3085 --no-open
```

**注意：不能去掉代理环境变量。** 102 访问 gitcode.com 依赖它自带的 `127.0.0.1:8889` 代理；我第一轮清掉代理后直接得到 `fetch failed`。

令牌放在 0600 的配置文件里而不是环境变量里，因为进程环境在共享机器上通过 `/proc` 可读。

---

## 七、遗留与下一步

**遗留一，用量记录不真实。** `runs.usage.turns` 恒为 0，`stage_execs.usage` 只记累计会话数。并入 T8。

**遗留二，不知道一次评审覆盖了多少文件。** `collect` 的 diff 摘要没有进事件或报告。并入 T7 的面板展示，或在 T8 前补一个 `collect.summary` 事件。

**遗留三，Standard 档在真实 PR 上 376 秒。** 与预算表的 25 分钟上限相比不超，但慢。要等 T8 有了真实用量数据再决定是否调 finder 数量或提示词长度。

**下一步 T7：** HTTP 接口与最小面板。任务书的验收是"不用命令行，能在浏览器里完成发起评审、看进度、看发现、标注处置"。这也是目标里"有面板可看可处置"那一条。
