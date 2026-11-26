# dsh-review

一个跑在 DeepSeek Harness（DSH）里的代码评审引擎。它读一个合并请求的差异，起若干只读的 agent 会话去找问题，核实这些发现，最后把结果放进一个本机面板里让人逐条处置。

**当前状态：原型，可以跑通，但不能直接交给别人用。** 第 8 节列出缺什么。

---

## 1. 它做什么，不做什么

**做。** 拿到一个 GitCode 合并请求，比较它的 base 与 head 两个提交，把差异与相关文件交给两个只读的审查会话（一个看正确性，一个看安全），收上来一批结构化发现，再交给独立的核实会话逐条验真，最后按严重度、既有问题、脱敏规则筛一遍，放进面板等处置。

**不做。** 它不发评论、不写 commit status、不合并代码。当前只实现了"记录"模式，也就是发现只落库、只显示在面板上。向平台写内容的那部分代码写了签名，但调用时直接抛 `NotEnabled`。这是有意的，理由见第 8 节。

---

## 2. 你需要先有什么

| 项 | 要求 | 为什么 |
|---|---|---|
| DSH | 0.2.2-alpha.3 或兼容版本 | 插件用了它的会话接口；0.1.x 没有 `dsh-agent-preset`，装不上 |
| Node.js | 24 以上 | 用到 `node:sqlite` 与类型剥离 |
| git | 2.32 以上 | 按提交建工作树 |
| GitCode 访问令牌 | 能读目标仓库的 PR 与评论 | 面板发起评审时要从平台取 PR 的 base/head |
| 目标仓库的本地克隆 | 一个 git clone | 引擎在克隆里建工作树，不在克隆里改代码 |

令牌放在一个只读自己可读的文件里，不要在命令行或环境变量里传。格式：

```json
{ "token": "你的令牌", "login": "你的账号" }
```

保存后把权限收紧：

```bash
chmod 600 ~/.config/gitcode/credentials.json
```

---

## 3. 安装

以下命令按顺序执行。约定：代码放在 `/opt/dsh-review`，DSH 配置根用 `/opt/dsh-review-home`，profile 名用 `review`。你可以换成自己的路径，但要保证后面每一处引用一致。

**第一步，装依赖并检查。**

```bash
cd /opt/dsh-review
pnpm install            # 只装 typescript 与 @types/node 两个开发依赖
node --test tests/*.test.ts    # 应当 156 条全过
```

测试全过再往下。不过就说明环境或代码有问题，不要继续。

**第二步，建一个独立 profile。**

```bash
export DSH_HOME=/opt/dsh-review-home
dsh review --from-default-profile web --dump-config > /dev/null
```

**第三步，写 profile 配置。**

编辑 `$DSH_HOME/profiles/review/cordis.patch.yml`，内容如下。把端口与模型换成本机可用的值。

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3085

- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      relay:
        displayName: 本地模型
        apiKeyEnv: RELAY_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:18080/v1
        models:
          - id: maas-deepseek-v4.1-flash-volcengine-codeagent
            name: deepseek-v4.1-flash
            contextWindow: 1048576
            maxTokens: 65536

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: relay
    model: maas-deepseek-v4.1-flash-volcengine-codeagent
```

**第四步，把插件装进这个 profile。**

```bash
dsh plugin --profile review add "link:/opt/dsh-review"
```

命令跑完后**必须手工检查** `$DSH_HOME/profiles/review/package.json` 里的 `dsh.profile.bundles` 有没有 `dsh-review`。没有就手工加上。安装器不会自动加，这是 DSH 的既定行为。

```json
"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-review"]
```

**第五步，写插件自己的配置。**

存成 `/opt/dsh-review-config.json`：

```json
{
  "stateDir": "/opt/dsh-review-state",
  "port": 3088,
  "repos": { "你的组织/你的仓库": "/opt/clones/你的仓库" },
  "targets": ["你的组织/你的仓库"],
  "pollSeconds": 60,
  "depth": "standard",
  "tokenConfigPath": "/opt/dsh-review-home/.config/gitcode/credentials.json",
  "resumeOnStart": true
}
```

各项含义：

| 字段 | 必填 | 含义 |
|---|---|---|
| `stateDir` | 是 | 数据库与运行期文件放这里。目录不存在会自己建 |
| `port` | 否 | 面板端口，默认 3087。**不能与 `webserver.port` 相同**，那是 DSH 自己的面板 |
| `repos` | 是 | 仓库名到本地克隆路径的映射 |
| `targets` | 否 | 只监听这些仓库；不写就是 `repos` 的全部键 |
| `pollSeconds` | 否 | 多久查一次有没有新提交，默认 60 |
| `depth` | 否 | 评审深度，`quick`（1 个审查会话）或 `standard`（2 个） |
| `tokenConfigPath` | 否 | 不写就要在环境变量里给 `GITCODE_TOKEN` |
| `resumeOnStart` | 否 | 重启后是否接着跑没跑完的活，默认是 |

**第六步，启动。**

```bash
export NVM_DIR=$HOME/.nvm; . $NVM_DIR/nvm.sh
export DSH_HOME=/opt/dsh-review-home
export DSH_REVIEW_CONFIG=/opt/dsh-review-config.json
export DSH_REVIEW_PROBE=/opt/dsh-review-plugin.log
export RELAY_API_KEY=<你的模型密钥>
export https_proxy=<你们的内网代理>       # 如果访问 gitcode.com 需要代理
export no_proxy=localhost,127.0.0.1

dsh review --host 127.0.0.1 --port 3085 --no-open
```

---

## 4. 怎么知道它起来了

**看探针文件。** `$DSH_REVIEW_PROBE` 指向的文件应当出现这几行，按顺序：

```
apply entered
config loaded: stateDir,port,repos,...
session/event listener attached
building deps
deps built
starting panel
panel up: http://127.0.0.1:3088/review/ui
resumed 0 runs
polling started every 60000ms
started: 1 targets
```

**为什么看文件而不是看日志：** DSH 启动这条路径上 `ctx.logger` 的输出不可见。我在开发时被这一点误导过一整轮，所以插件自己往文件里写。

**看端口。**

```bash
ss -lntp | grep -E ':3085|:3088'
```

两个都要在监听。**只有 3085 在、3088 不在，说明清理逻辑被提前执行了**，见第 7 节第一条。

**看面板。**

```bash
curl -s http://127.0.0.1:3088/review/api/health
# {"ok":true,"at":"..."}
```

然后用浏览器打开 `http://127.0.0.1:3088/review/ui`。

**看数据库。**

```bash
sqlite3 /opt/dsh-review-state/dsh-review.sqlite 'select pr, status, round from runs'
```

`sqlite3` 没装就用 python3：

```bash
python3 -c "
import sqlite3
con=sqlite3.connect('/opt/dsh-review-state/dsh-review.sqlite')
for row in con.execute('select pr, status, round from runs'): print(row)
"
```

---

## 5. 怎么用

**自动。** 插件每 `pollSeconds` 秒查一遍 `targets` 里所有开放中的合并请求。哪个请求的 head 提交是新的，就自动评审一次。你不用做任何事。

**手动。** 面板首页底部有"手动发起评审"表单，填仓库与 PR 号即可。

**看结果。** 首页三栏：等你处理、进行中、已完成。点任一条进详情页，能看到九个阶段各自的状态与耗时、每条发现的票数与位置。

**处置。** 每条发现后面有四个按钮：成立、误报、有意为之、不重要。点一下就把判断记进库，并改该条发现的状态——判"成立"保持已核实，其余三个把发现关掉。被判误报的问题，后续轮次不再报。

**出报告。** 观察期结束后生成决策包：

```bash
node scripts/decision.mjs --db /opt/dsh-review-state/dsh-review.sqlite --days 6
```

它读库里的运行、发现、处置，算四个指标，判断要不要进入下一步，输出一页 Markdown。数据不足时它会直接说"数据不足"，不编建议。

---

## 6. 三种运行方式

| 方式 | 命令 | 用途 |
|---|---|---|
| 常驻插件 | 见第 3 节第六步 | 正常使用；自动轮询 |
| 一次性评审 | `node spike/t8/index.js`（需 DSH 宿主，或改用 `src/app/cli.ts` 的 `runOnce`） | 评测某个用例 |
| 只读面板 | `node spike/t7/serve.mjs` | 不起 DSH，只把已有数据库显示出来 |

命令行入口在 `src/app/cli.ts`，导出 `runOnce` 与 `runTrigger`。目前没有做成可直接执行的 `bin`，这是缺项之一。

---

## 7. 六个已知的坑

按踩到的次数排，每一条都真出现过。

**一，`ctx.effect` 的用法。** 它是 `effect(setup)`，`setup` 返回清理函数，清理函数在卸载时才调用。写成"setup 里直接清理"会让面板与数据库在启动瞬间被关掉，症状是端口不监听、随后每个轮询报 `database is not open`。

**二，`.js` 与 `.mjs` 里不能有任何 TypeScript 语法。** `export type` 会直接语法错。Node 只对 `.ts` 做类型剥离。

**三，`dsh plugin add` 不把插件加进 bundles。** 必须手工改 `package.json`。

**四，`restrict` 的允许名单只能写全局工具名。** 把自己注册的工具名写进去会报 `unknown global tools`；自作用域的注册本来就对限制免疫。

**五，工具注册的 `output` 必须同时给 `schema` 与 `render`。** 只给 `schema` 会报错。

**六，消息投递的来源必须是 `user-rpc`。** 自定义来源会被静默丢弃：投递返回成功、状态照常翻动，但模型收不到提示词。

---

## 8. 现在的边界，别当成成熟产品

**已经验证过的：**

- 156 个自动化测试通过；`src/core` 与 `src/stages` 在完全不给 Node 类型的情况下也能通过类型检查（这证明领域逻辑不依赖任何运行时）
- 在真实仓库 `TokensService/tokens-worktable` 的两个开放合并请求上跑完整条流水线，结果落库
- 面板显示真实数据，健康检查、同源检查、四个处置按钮都有测试
- 插件常驻运行、自动轮询、崩溃后从断点恢复

**没有验证过的，用之前必须知道：**

1. **它没有在真实代码里找到过真实缺陷。** 真实两个请求都是 0 条发现。找到过的是我注入进去的缺陷（两次运行，命中 2/2 与 1/2）。
2. **准确率未知。** 同一批用例连跑两次命中率 100% 与 50%，说明结果本身不稳定。任何"可用性"判断都需要多次运行的均值。
3. **误报率未知。** 干净用例上 0 条，但样本只有 1 个。
4. **token 成本未知。** 宿主取不到单会话 token 数。会话数与耗时是准的：quick 档 15 到 39 秒、1 到 2 个会话；standard 档在真实请求上 376 秒。
5. **发评论的能力没开。** `publish.mode` 只实现 `record`。
6. **没有面板配置页。** 阶段配置、提示词版本、预算都得改文件。

**缺的工程件：** 一个可执行的 `bin/dsh-review`、一个配置校验器、提示词的版本管理界面。

---

## 9. 目录结构

```
dsh-review/
  index.mjs              插件入口的薄包装（.mjs，不能有 TS 语法）
  cordis.patch.yml       两个只读 agent 预设：无 shell、无网络、不能写文件
  src/
    index.ts             插件装配：读配置、起面板、起轮询、崩溃恢复
    core/                领域逻辑，零外部依赖，全部可单测
      model.ts           类型总表
      ports.ts           六个端口：平台、仓库、会话、存储、通知、风险
      stage.ts           阶段接口与三种结果
      pipeline.ts        九个阶段的顺序与三档预设
      budget.ts          预算记账与三档硬上限
      invariants.ts      八条防循环不变量
      fingerprint.ts     发现指纹，自写 UTF-8 与 SHA-1
      sanitize.ts        脱敏：十类规则加高熵串
      run.ts             流水线编排
    stages/              九个阶段的具体实现
      deterministic.ts   collect、plan、dedupe、classify、filter
      agents.ts          find、verify（唯一会起会话的两个）
      publish.ts         gate、publish
    adapters/            外部世界，允许用 node:*
      dsh-agent-runner.ts  把一次评审请求变成一次真实会话
      gitcode-forge.ts     平台只读客户端
      git-cli.ts           按提交建工作树、读文件、解析差异
      sqlite-store.ts      七张表
      fakes.ts             假件，测试用
    app/
      scheduler.ts       运行状态的唯一写入者
      trigger.ts         轮询
      http.ts            接口与面板服务
      views.ts           服务端渲染
      eval.ts            评测集与指标
      decision.ts        决策包
      cli.ts             组合根
  tests/                 156 条
  prompts/               三份判据
  scripts/               挖掘与决策包两个脚本
  spike/                 五个阶段的验证装置，不进主流程
  docs/                  九个 T 的验证报告
```

---

## 10. 一句话

它能跑、能看、能处置，但**还没被证明能在真实代码上找出真实缺陷**。在跑满一段观察期、拿到真实处置数据之前，它只是一个装置，不是一个可以依赖的评审员。
