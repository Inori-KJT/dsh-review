# T7 HTTP 接口与最小面板验证报告

2026-11-26 · 执行者：本会话

**结论：T7 通过。不用命令行就能在浏览器里发起评审、看进度、看发现、标注处置。四项验收全部有证据，其中"看发现"这一项只在假数据上验过，真实 PR 那次产出 0 条发现，这一点在第四节说明。**

---

## 一、新增的四个文件

| 文件 | 作用 |
|---|---|
| `src/app/views.ts` | 服务端渲染。纯函数：给数据，出 HTML 字符串 |
| `src/app/http.ts` | 路由、同源检查、请求解析与四种处置动作 |
| `tests/http.test.ts` | 13 条，用真实 HTTP 与内存 SQLite 测路由与状态联动 |
| `spike/t7/serve.mjs` | 现场验证：用 T6 落库的真实运行启动面板 |

面板刻意不用框架、不用 WebSocket：整页每 5 秒刷新足够看出进度，而整页刷新意味着任何浏览器、任何禁用脚本的环境都能用。

---

## 二、路由与安全

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/review/api/health` | 健康检查 |
| GET | `/review/ui` | 面板首页：等你处理 / 进行中 / 已完成三栏 + 发起表单 |
| GET | `/review/ui/run?id=` | 运行详情：阶段导轨、发现表、四个处置按钮、取消 |
| GET | `/review/api/runs` | 三栏计数 |
| GET | `/review/api/runs/:id` | 运行详情 JSON |
| POST | `/review/api/runs` 与 `/runs-form` | 发起评审 |
| POST | `/review/api/runs/:id/cancel` 与 `/cancel-form` | 取消 |
| POST | `/review/api/findings/:id/feedback` 与 `/feedback-form` | 四个处置按钮 |
| POST | `/review/api/findings/:id/release` 与 `/release-form` | 放行被扣下的发现 |

两条安全规则，都有测试：

**只监听 `127.0.0.1`**，因此本机以外不可达。

**所有请求做 Host 检查，写请求额外做 Origin 检查。** 现场验证时用一个伪造的 `Host: evil.example.com` 请求，返回：

```
status=403
```

这条在单测里也覆盖了。注意 `fetch` 规范禁止覆盖 `host` 头，所以那条测试用的是底层 `node:http` 请求——这一点写进了测试注释，免得后来的人以为可以在 `fetch` 里设。

---

## 三、四项验收

### 3.1 看进度与发起

用 T6 落库的真实数据库启动面板：

```
[t7] 库里有 4 次运行
[t7]   run-0004 TokensService/tokens-worktable#311 status=queued 发现=0
[t7]   run-0003 TokensService/tokens-worktable#312 status=queued 发现=0
[t7]   run-0002 TokensService/tokens-worktable#311 status=queued 发现=0
[t7]   run-0001 TokensService/tokens-worktable#312 status=done   发现=0
[t7] 面板: http://127.0.0.1:3087/review/ui
```

首页抓下来 3519 字节，关键片段命中：

```
1  等你处理
1  进行中
1  已完成
1  手动发起评审
2  tokens-worktable #311
2  tokens-worktable #312
1  refresh" content="5
```

三栏、真实 PR、自动刷新标记都在。

### 3.2 看发现与标注处置

这两项在 `tests/http.test.ts` 里用假适配器覆盖（真实 PR 那次 0 条发现，见第四节）：

- 发起评审后 `/review/api/runs` 的三栏计数为 1
- 运行结束后详情页含"阶段导轨"、"发现"与四个处置按钮
- 点"误报"后 `feedback` 表新增一行（`source=panel`、`verdict=false-positive`），发现状态变为 `dismissed`
- 非法 `verdict` 返回 400
- "放行"把 `held` 改成 `verified`
- 取消接口把运行状态改为 `cancelled`
- 未知路由 404 并回显路径

### 3.3 处置与状态的联动规则

四个按钮不是单纯记一笔反馈，它们同时改发现状态：

- **成立** → `verified`
- **误报 / 有意为之 / 不重要** → `dismissed`

这条规则与 core 里第 4 条不变量配套：被判误报或有意为之的指纹，后续轮次不再报。因此面板上点一下，下一轮就不会再看到同一条。

---

## 四、诚实标注：真实数据没走完的那一段

T6 那次真实评审产出 **0 条发现**（PR #312 是配置与脚本调整）。因此：

- **"看进度"在真实数据上验过了**：4 次真实运行、真实 PR 号、真实状态。
- **"看发现"只在假数据上验过**：测试里注入一条 Nit 走完整条流水线，因此发现表、票数、四个按钮、状态联动都有断言，但**没有一条真实发现渲染过**。

这个区别要记住：面板的渲染代码是对的（有测试），但它对"真实发现的文字长度、证据形态、中文排版"的适配尚未被真实数据检验过。等 T9 试运行有了真实发现再回头看。

---

## 五、现场验证顺手发现的一个真问题

启动面板后发现 T6 落库的三次运行状态一直是 `queued`，从未推进。

根因：`PollingTrigger.pollOnce` 只调 `submit`，不调 `start`。T6 的验证装置直接用触发器，因此提交完就没人推进——**提交与推进之间的那一步缺了**。

修法：给 `PollingTriggerOptions` 加一个可选的 `start` 回调，提交成功后对新运行立刻推进，复用的不动。附带一条测试：

```
test('提交之后自动推进新运行，复用的不重复推进')
```

这个缺口值得记一句：**它不会报错，只会让运行永远停在 queued。** 如果不是去面板里看了一眼，这一条会一直藏着。

---

## 六、测试与类型检查

全套 **133 个测试通过**（新增 13 条 HTTP + 1 条触发器推进）。

两档类型检查都干净：

- `tsconfig.json`（全部，`types: ["node"]`）
- `tsconfig.pure.json`（只有 `core` 与 `stages`，`types: []`）——领域逻辑仍不依赖任何运行时

---

## 七、复现

```bash
# 面板现场验证（不需要 DSH，只读数据库）
export NVM_DIR=/root/.nvm; . /root/.nvm/nvm.sh
cd /root/zhaochi/dsh-review-t7
SPIKE_STATE=/root/zhaochi/t6-state.db SPIKE_PORT=3087 node spike/t7/serve.mjs

# 从 102 上看
curl -s http://127.0.0.1:3087/review/api/health
curl -s http://127.0.0.1:3087/review/ui | head -40
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example.com' http://127.0.0.1:3087/review/api/health
```

---

## 八、遗留与下一步

**遗留一，面板未接进 DSH 侧栏。** 现在是独立 HTTP 服务，靠 URL 打开；任务书的 P2 阶段才要求挂进 DSH 侧栏与 WebSocket 推送。

**遗留二，没有配置页。** 阶段配置、finder 提示词版本、预算表都还不能在面板上改，仍是改代码或改 `cordis.patch.yml`。

**遗留三，用量与覆盖率仍不可见。** 与 T6 同一项：`usage.turns` 恒为 0，且不知道一次评审覆盖多少文件。这是 T8 的事。

**下一步 T8：** 评测集与基线。要写挖掘脚本（从 revert 与修复提交反推缺陷用例）、干净集筛选、`dsh-review eval` 命令，产出一份基线报告，并据此修订预算表。T8 之后 T9 是 5 到 7 天的只记录试运行。
