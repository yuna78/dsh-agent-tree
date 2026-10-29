# 兼容性

## 已验证组合

| 项目 | 版本 | 结果 |
|---|---|---|
| DSH | `0.2.1-rc.2`（npm 全局安装，Web profile） | 通过：座位注册、树、模型、定时、外部进程接口、鉴权（未登录 401） |
| Node.js | 22.x / 24.x | 通过：单测与 verify 脚本 |
| macOS | 14/15（Apple Silicon） | 通过（`ps` + `lsof` 进程探测） |
| Linux | 未实机验证 | 预期可用（两者都是 POSIX 工具，参数一致） |
| Windows | 不支持进程段 | 树本身正常；进程探测依赖 `ps -axo` / `lsof`，不可用 |

## 依赖契约

- 客户端座位：`shell.overlay`（z-index 20 的浮层，`pointer-events` 只在卡片和按钮上开启）。
- 客户端服务注入：`@deepseek-ai/dsh-client-ui-workspace`（`ctx.workspaces.list`、`ctx.uiWorkspace.openSession`）。
- 客户端用到的数据：
  - `useSessions()` / `useSessionStatus()`（拿不到时回落 `ctx.remote.$on('api-session/status')`）
  - `projectionValues.subagentTiming` / `projectionValues.modelSelection`
  - `ctx.remote.schedule.catalog()` + `schedule/changed`
  - `ctx.sessions.subagentAddress()`
- 宿主侧服务：`webServer`（`ctx.webServer.register`）+ `connection.requestRejection` 鉴权。

## 预发布版本的 peer 坑

DSH 还在 `-rc` 线时，`peerDependencies` 的范围必须**显式带上当前预发布标签**，否则 node-semver 会静默排除它：

```json
"peerDependencies": { "@deepseek-ai/dsh": ">=0.2.1-rc.2 <0.3.0" }   // ✅
"peerDependencies": { "@deepseek-ai/dsh": ">=0.2.1-rc.1 <0.3.0" }   // ❌ 0.2.1-rc.2 被排除
```

`engines.dsh` 同理（本包两者都写了，安装时会校验）。

## 已知不兼容 / 限制

- **0.2.0 及更早**：客户端 `shell.overlay` 座位与 `schedule` 服务都不保证存在，不保证可用。
- **其它前端**（CLI、Desktop）：本插件只注册 Web 客户端座位，非 Web 端不出现卡片。
- **多实例**：只看得到当前 Web 实例里的会话；`claude/codex` 进程段看的是本机所有进程（这是有意为之）。

## 变更记录

见 [CHANGELOG.md](../CHANGELOG.md)。
