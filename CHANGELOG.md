# Changelog

## 0.1.0 — 2026-10-28

首个公开版本。从「一个会话里翻着看 subagent 太累」长出来的一张小卡片。

### 功能

- **迷你 agent 树**：226px 级浮动卡（`shell.overlay` 座位），`workspace → 对话 → subagent → 孙代理` 真树，`├─ └─ │` 连接线，只保留通往活跃分支的路径，`▾/▸` 逐级折叠。
- **常驻入口**：空闲时自动收成一条窄条（`● Agent 树 ▸`），永不消失；有活儿自动展开。
- **颜色编码**：顶层对话绿点、第 2 层 subagent 蓝点、第 3 层及更深紫点、已结束灰点。
- **模型标签**：每行右侧显示该会话实际在用的模型（`projectionValues.modelSelection`，`next` → `lastUsed`），subagent 未记录时继承上级。
- **定时任务**：读 `schedule.catalog() + schedule/changed`，间歇式工作的会话即使当前没在跑也列出，带 `⏱8m` 倒计时与「N 个定时」计数。
- **外部 agent 进程**：宿主半部新增只读接口 `GET /local/dsh-agent-tree/processes`，用 `ps` + `lsof` 发现本机正在跑的 `claude` / `codex` CLI，卡片底部单独一段展示（kind / 项目目录 / 已跑时长 / CPU）。
- **点击跳转**：点任意一行 → `subagentAddress` + `uiWorkspace.openSession` 跳到对应会话（含 subagent）。
- **拖动与记忆**：拖标题栏移动，位置存 `localStorage`。

### 健壮性

- 宿主路由：`webServer` 缺失则 warn 跳过、注册包 try/catch、只读 GET、复用 `connection.requestRejection` 鉴权（未登录 401）、`ps`/`lsof` 超时、结果缓存 3 秒、最多 8 条。
- 客户端：没有 global props 时回落到轮询快照并自行订阅 `api-session/status`；`schedule` 服务缺失时静默跳过。
- 20 项本地校验（`node --test test/*.test.mjs` + `node verify/smoke.mjs`）。

### 兼容

- 验证于 DeepSeek Harness `0.2.1-rc.2`（Web profile）。
