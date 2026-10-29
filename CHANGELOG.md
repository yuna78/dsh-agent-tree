# Changelog

## 0.1.1 — 2026-10-29

- **定时 / 循环任务加小闹钟**：挂了定时任务的会话，标题前固定有一个 `⏰`，右侧显示距下次触发的倒计时（`8m` / `2h` / `3d`）。
  刚触发过、倒计时到期的显示 `now`，但 `⏰` 不会消失——之前只有「还没到点」的行才有标记，正在跑或刚跑完的循环任务看起来和普通会话一样。
- 倒计时不再重复画 `⏱` 图标：图标统一挪到标题前，右侧只留数字。
- **本机多个 dsh 实例**：同时开多个 `dsh web --port 30xx` 时，别的实例里正在跑的会话也会出现在卡上。
  每个实例是一个顶层节点（`dsh :3083`），下面是它当前打开着的会话（标题取自共用的会话目录），
  点一下在新标签打开那个实例。宿主半部用 `ps` + `lsof` 读监听端口与打开的会话文件，不需要跨实例接口/鉴权。

## 0.1.0 — 2026-10-29

首个公开版本。从「一个会话里翻着看 subagent 太累」长出来的一张小卡片。

### 功能

- **迷你 agent 树**：288px 浮动卡（`shell.overlay` 座位），根节点 `dsh` → `workspace` → `对话` → `subagent` → `孙代理`，`├─ └─ │` 连接线，只保留通往活跃分支的路径，`▾/▸` 逐级折叠。
- **常驻入口**：空闲时自动收成一条窄条（`● Agent 树 ▸`），永不消失；有活儿自动展开。
- **颜色编码**：顶层对话绿点、第 2 层 subagent 蓝点、第 3 层及更深紫点、已结束灰点。
- **模型标签**：每行右侧显示该会话实际在用的模型（`projectionValues.modelSelection`，`next` → `lastUsed`），subagent 未记录时继承上级。
- **定时任务**：读 `schedule.catalog() + schedule/changed`，间歇式工作的会话即使当前没在跑也列出，带 `⏱8m` 倒计时与「N 个定时」计数。
- **外部 agent 进程（带子树）**：宿主半部只读接口 `GET /local/dsh-agent-tree/processes`，用 `ps` + `lsof` 发现本机正在跑的 `claude` / `codex` CLI，并按 `ppid` 把它们的子进程挂成子树（同类子进程归组成 `computer use ×4` / `MCP ×3` 这样的行）。它们和 `dsh` 是**同级的顶层 agent 节点**（本机 agent 列表），用同一套行规格，可折叠。
- **点击跳转**：点任意一行 → `subagentAddress` + `uiWorkspace.openSession` 跳到对应会话（含 subagent）。
- **拖动与记忆**：拖标题栏移动，位置存 `localStorage`。
- **「等你拍板」的会话不再消失**：读实时状态里的 `pendingInteraction`（`question` / `approval` / `plan-review`），这类会话即使没在跑也会列出，琥珀色圆点 + `待答 / 待批 / 待审` 徽标，排在在跑的前面；标题栏变成「N 个等你处理 · M 个在跑 · K 个定时」。
- **定时任务显示修复**：`remote.schedule` 是别的客户端插件挂上来的命名空间服务，只读 `ctx.remote.schedule` 在它还没挂上时会拿到 undefined，导致定时任务整段消失；现在用 `ctx.get('remote.schedule')` 兜底并继续轮询。
- **codex 行名改成会话标题**：从 rollout 里取第一条真实用户消息（跳过 `environment_context` / `AGENTS.md` 注入）当行名，取不到才回落目录名；右侧加灰色目录小标签；同 cwd 的多个 codex 进程按时间各认领一条会话，避免多行同名。
- **codex 的子对话**：读 `~/.codex/sessions/**/rollout-*.jsonl` 的 `session_meta`，按 `parent_thread_id` 还原 subagent 线程树，挂在 codex 行下面（昵称 + agent 路径 + 最后活动时间 / `running`）；按 cwd、cwd 前缀、桌面端 originator 三级匹配主线程。
- 顶层改成「本机 agent 列表」：`dsh` 与 `claude` / `codex` 同级，各自展开自己的子树；行规格统一。

### 健壮性

- 宿主路由：`webServer` 缺失则 warn 跳过、注册包 try/catch、只读 GET、复用 `connection.requestRejection` 鉴权（未登录 401）、`ps`/`lsof` 超时、结果缓存 3 秒、最多 8 条。
- 客户端：没有 global props 时回落到轮询快照并自行订阅 `api-session/status`；`schedule` 服务缺失时静默跳过。
- 客户端模块 id 与包名统一为 `dsh-plugin-agent-tree`（此前是本地 `@local/...`）。
- 20 项本地校验（`node --test test/*.test.mjs` + `node verify/smoke.mjs`）。

### 兼容

- 验证于 DeepSeek Harness `0.2.1-rc.2`（Web profile）。
