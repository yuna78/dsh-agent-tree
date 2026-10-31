# 兼容性

## 支持范围

本插件声明并实测了 **DSH 两条版本线**：`0.2.0-rc.2`（0.2.0 线的最后一版）与 `0.2.1-rc.x`。

| DSH 版本 | 结果 |
|---|---|
| `0.2.1-rc.2` | 通过：开发基线（座位注册、树、模型、定时、外部进程接口、鉴权未登录 401） |
| `0.2.1-rc.3` ~ `0.2.1-rc.5` | 未逐项实测：范围收下它们，且本插件用到的契约与 rc.2 一致 |
| `0.2.0-rc.2` | 通过：安装（**无需** `allow-version` 豁免）、宿主行插入、客户端模块下发、`shell.overlay` 座位、卡片渲染、`GET /local/dsh-agent-tree/processes` 401/200 —— 2026-10-31 隔离安装 + headless Chromium 实测 |
| `0.2.0-rc.1` | 未实测：范围从 `0.2.0-rc.2` 起（同一小版本线，依赖 API 逐项比对一致） |
| `0.1.x` 及更早 | 不支持：未验证，客户端座位与服务不保证存在 |
| `0.3.x` 及以后 | 未适配（上界先挡在 `<0.3.0`） |

| 其它 | 版本 | 结果 |
|---|---|---|
| Node.js | 22.x / 24.x | 通过：单测与 verify 脚本 |
| macOS | 14/15（Apple Silicon） | 通过（`ps` + `lsof` 进程探测） |
| Linux | 未实机验证 | 预期可用（两者都是 POSIX 工具，参数一致） |
| Windows | 不支持进程段 | 树本身正常；进程探测依赖 `ps -axo` / `lsof`，不可用 |

## 依赖契约

- 客户端座位：`shell.overlay`（list / scope root 的浮层，`pointer-events` 只在卡片和按钮上开启）。
- 客户端服务注入：`sessions` / `slots` / `workspaces` / `remote` / `uiWorkspace`；模块依赖
  `@deepseek-ai/dsh-client-ui-workspace`（`ctx.workspaces.list`、`ctx.uiWorkspace.openSession`）。
- 客户端用到的数据：
  - `useSessions()` / `useSessionStatus()`（拿不到时回落轮询 + `ctx.remote.$on('api-session/status')`）
  - `projectionValues.subagentTiming` / `projectionValues.modelSelection`
  - `ctx.remote.schedule.catalog()` + `schedule/changed`（服务不存在时静默跳过）
  - `ctx.sessions.subagentAddress()`
- 宿主侧服务：`webServer`（`ctx.webServer.register`）+ `connection.requestRejection` 鉴权。

以上每一项在 `0.2.0-rc.2` 与 `0.2.1-rc.2` 里都逐个比对过，签名与语义一致，因此**没有任何按版本分叉的兼容代码**。

## 两条版本门：为什么 engines 和 peer 必须一起放宽

DSH 检查「插件能不能装」时，两条版本线读的不是同一个字段：

| DSH | 读什么 | 不满足时 |
|---|---|---|
| `0.2.0-rc.2` | **只读 `peerDependencies`**（`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`），`engines.dsh` 完全不参与 | `dsh: installation rejected: …`，安装原子回滚 |
| `0.2.1+` | manifest 里有 `engines.dsh` 就**只认它**，peer 范围被忽略 | 启动时 `skipping profile bundle`，插件静默缺席 |

所以只放宽一处 = 另一条线照样装不上。本包两处写同一个范围：

```json
"engines":          { "dsh": ">=0.2.0-rc.2 <0.3.0" },
"peerDependencies": { "@deepseek-ai/dsh": ">=0.2.0-rc.2 <0.3.0" }
```

- **区间必须显式带预发布**：DSH 用 `semver.satisfies(runtime, range, { includePrerelease: true })` 判定，
  `>=0.2.0-rc.2 <0.3.0` 同时收下 `0.2.0-rc.2`、`0.2.1-rc.x`、`0.2.2-alpha.x`；`0.2.0-rc.1`、`0.1.x`、`0.3.0` 仍被挡在外面。
- 反过来，`>=0.2.1-rc.1 <0.3.0` 这种下界写低的写法会 **静默排除** `0.2.1-rc.2` —— 也就是 0.1.0～0.1.4 的老范围
  会让 0.2.0 线整条装不上的原因。
- **pnpm 那边只会 WARN**（`missing peer @deepseek-ai/dsh@…`，因为宿主不在 profile 依赖里，是正常的），
  真正拦安装的是 DSH 自己的 `evaluatePluginCompatibility`；它用 `allow-version` 可以豁免，本包从 0.1.5 起不需要豁免。
- `verify/smoke.mjs` 把这件事钉成了回归门：两处范围必须相等，且必须收下 `0.2.0-rc.2` / `0.2.1-rc.x`、
  挡掉 `0.1.x` 与 `0.3.0`。范围改错，`npm run verify` 直接红。

## 0.2.0-rc.2 的实测记录（2026-10-31）

隔离环境（不碰本机 `~/.dsh` 与 :3080 上的实例）：

1. `npm i --prefix /tmp/dsh020 @deepseek-ai/dsh@0.2.0-rc.2`，`DSH_HOME=/tmp/dsh020-home` 下从 shipped `web` 模板建 profile。
2. `dsh plugin --profile web add dsh-plugin-agent-tree@0.1.5` → 安装成功，**没有** `installation rejected`、没有 `allow-version`。
3. `dsh --profile web --port 3199` 启动 → boot log 里没有任何 `[dsh-agent-tree]` 警告。
4. `GET /local/dsh-agent-tree/processes`：未登录 `401`、带 cookie `200`（真实 JSON：`{at, processes[], instances[]}`）、
   错误兄弟路径 `404` —— 证明路由确实注册上了，不是全局 401 兜底。
5. 前端 module manifest 里有 `dsh-plugin-agent-tree/client.js`，bundle 取回 `HTTP 200`；headless Chromium 里
   `div.dsh-agent-tree-root.dsh-agent-tree-pill` 正常渲染、无 pageerror。
6. 已知退化：0.2.0-rc.2 的 `web` 模板没带 schedule bundle，`/api/schedule/catalog` 会 404 → 定时任务倒计时不显示，
   客户端静默降级，其它功能不受影响。

## 已知不兼容 / 限制

- **0.1.x 及更早的 DSH**：未验证，客户端座位（`shell.overlay`）与服务不保证存在，不保证可用。
- **其它前端**（CLI、Desktop）：本插件只注册 Web 客户端座位，非 Web 端不出现卡片。
- **多实例**：只看得到当前 Web 实例里的会话；`claude/codex` 进程段看的是本机所有进程（这是有意为之）。
- **0.2.0-rc.2 的 schedule**：见上面「已知退化」，倒计时可能缺席。

## 变更记录

见 [CHANGELOG.md](../CHANGELOG.md)。
