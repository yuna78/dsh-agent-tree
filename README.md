# Agent Tree · DSH 迷你 agent 树

简体中文 · [English](README.en.md)

![Agent Tree：展开是一张 288px 的卡，收起是一颗胶囊；皮肤装饰真的长在 dock 外面](docs/assets/screenshot-capsule.png?v=0.1.3)

**Agent Tree** 是 DeepSeek Harness（DSH）Web 端的可观测性小插件：右下角一张 **288px 宽的浮动卡**，
用 `git log --graph` 那种连接线，把 `dsh → workspace → 对话 → subagent → 孙代理` 实时画出来。只显示
**正在干活或有定时任务的分支**，所以卡永远小；没有活儿时自动收成一颗**圆头圆脑的胶囊**，但不会消失。

解决的问题很具体：对话一多，就得挨个会话切进去看「这个 subagent 到底在干什么」。DSH 侧栏只列会话，
不列 agent 谱系；Activity 面板要么太大、要么和当前 rc 版本不兼容。这张卡补上这块——**一眼看到谁在跑、
跑在哪个层级、用哪个模型、跑了多久、下一步什么时候自动来**。

![在 DSH 页面里：右下角一张常驻小卡，樱花从 dock 外面长出来（示意数据）](docs/assets/screenshot-app.png?v=0.1.3)

## 有什么

- **顶层就是 agent 列表**：`dsh`（这个实例）和本机的 `claude` / `codex` 是**同级**的顶层节点，各自往下展开自己的树：`dsh → workspace → 对话 → subagent → 孙代理`；`├─ └─ │` 逐层缩进；`▾ / ▸` 逐级折叠。
- **plugin dock 式窗口头**：卡片顶部多一层——左边是插件 icon + 名字 **Agent Tree Dock**，中间是状态副行（`1 待处理 · 5 在跑 · 3 定时`），右边三个无底色 ghost 图标：**颜料滴**（换肤）/ **转圈**（检查更新）/ **—**（最小化），静止时只是淡淡的浅灰，hover 才出现浅底。
- **常驻入口（胶囊）**：空闲自动收成一颗圆头圆脑的胶囊 `🌳 Agent Tree Dock 1 待处理 🤖5 ⏰3 ⌃`——三种计数各自只在非零时出现：琥珀 `N 待处理`（等你拍板）、绿色机器人 `🤖N`（N 个 agent 在跑）、单色闹钟 `⏰N`（N 个定时任务）；空闲时只剩 icon + 名字 + 展开箭头。点胶囊（或 `Enter` / `Space`）展开，按住可拖动；手动折叠优先于自动折叠。
- **颜色即层级**：顶层对话绿点、第 2 层 subagent 蓝点、第 3 层及更深紫点、已结束灰点。
- **每行右侧模型标签**：读会话投影 `modelSelection`（`next` → `lastUsed`），压成 `v4.1-flash` 这类短标签；
  subagent 没有自己的记录时继承上级（悬停会标注）。
- **本机多个 dsh 实例**：同时开好几个 `dsh web --port 30xx` 时，别的实例里正在跑的会话也会出现在卡上——
  每个实例一个顶层节点（`dsh :3083`），右上角是「会话数 · subagent 数」，下面挂它**还在干活**（或等你拍板）的会话——
  几小时前停着的会话、以及整个没有活儿的实例节点会直接收掉；
  每个会话行右边是「挂了几个 subagent」（`▸` 可展开看是哪几个），点一下在新标签打开那个实例。
  宿主半部用 `ps` + `lsof` 发现端口和会话，走本机文件，不需要跨实例鉴权。
- **定时任务倒计时**：读 Automation tasks 的 `schedule.catalog()`（服务名 `remote.schedule`，命名空间没挂上时用
  `ctx.get` 兜底），间歇式工作的会话**即使现在没在跑也会列出**，右侧显示 `⏱8m / ⏱2h / ⏱3d`。
- **需要你拍板的会话来最上面**：agent 提问、等你批准操作、等你审阅计划时（`pendingInteraction` = `question` /
  `approval` / `plan-review`），那一行**换成琥珀色**、带 `待答 / 待批 / 待审` 小徽标，并且**排在在跑的之前**——
  以前这类会话因为「没在跑」会直接消失。
- **本机外部 agent 进程（也是树）**：插件宿主半部提供只读接口，用 `ps` + `lsof` 找到本机正在跑的 **claude / codex CLI**，
  再按 `ppid` 把它们的子进程挂成子树（如 codex 的 `computer use ×4` / `MCP ×3` / `code mode`）。它们是**和 `dsh` 同级的顶层 agent 节点**，行规格完全一致，可折叠。
  ChatGPT 桌面端里的 `Codex Framework` 辅助进程本身不会被误认成 CLI。
- **codex 的行名是它自己的会话标题**：从 rollout 里取第一条**真实**用户消息（跳过 `environment_context` /
  `AGENTS.md` 这类上下文注入）当行名，比如 `codex 推进一下能推进的任务…  devline`；取不到才回落到目录名。
  多个 codex 进程同 cwd 时会各认领一条会话，不会三行同名。
- **codex 的子对话也看得见**：读 codex 自己的会话记录（`~/.codex/sessions/**/rollout-*.jsonl` 的第一行
  `session_meta`），按 `parent_thread_id` 还原它的 subagent 线程树，挂在 codex 那行下面——
  `● Hubble advance_review_logic  running` / `● Carson review_nextarchive_code  16m前`。
  只读本机文件、不联网、不外发（唯一例外：你主动点「检查更新」时向 npm registry 发一次只读 GET）。（claude 的 sidechain 结构不同，暂未解析。）
- **点一行就跳过去**：`subagentAddress(id)` + `uiWorkspace.openSession()`，连 subagent 也能直接落到它的对话。
- **检查更新（要你点才联网）**：窗口头的转圈按钮点一下才向 npm registry 查一次 `latest`（只读 GET，不带 cookie、
  不自动轮询），显示「已是最新 v0.1.3」或「发现新版本 vX」并给出一条可直接复制的升级命令；上次检查结果缓存
  30 分钟，有新版时按钮上挂一个小圆点。唯一联网的地方就是这里。
- **皮肤（可 DIY，QQ 皮肤那种）**：窗口头的颜料滴按钮切换配色——内置 **默认 / 樱花 / 鲸鱼娘** 三套：卡片底色、
  标题层 banner、重画过的樱花 / 鲸鱼 icon、边框 / 阴影和胶囊配色，深色模式各有暗色变量。樱花、鲸鱼娘还带
  **真正的透明底插画素材**（一整枝樱花、浪花里的小鲸鱼），渲染在卡片**外面、窗口后面**，像从 dock 边缘长出来；
  收起成胶囊时也会冒出一小枝。自己加一套不用改代码，往 `window.__DSH_AGENT_TREE_SKINS__` 里注册 `--dat-*` 变量
  和 `decor` 图片即可，见 [皮肤指南](docs/skins.md)。
- **拖动 + 位置记忆**：拖窗口头（或收起后的胶囊）移动，位置存 `localStorage`，下次还在原处。

## 3 分钟安装

前置：Node.js `^22.19 或 ≥24`（与 DSH 运行时一致）、pnpm 10+、DSH `≥ 0.2.1-rc.2 < 0.3`（已验证 `0.2.1-rc.2`）。

```sh
# 1) 建一个专用 profile（也可以装到现有的 web profile）
dsh --profile agent-tree --from-default-profile web

# 2) 从 npm 安装
dsh plugin --profile agent-tree add dsh-plugin-agent-tree

# 3) 启动
dsh --profile agent-tree --port 13090
```

**装完必须重启一次 `dsh`**（宿主半部注册了进程接口），然后浏览器硬刷新（`Cmd/Ctrl + Shift + R`）。

其他安装方式：

```sh
# 装到已有 profile
dsh plugin --profile web add dsh-plugin-agent-tree

# 从 GitHub 源码装（带完整提交历史，适合改代码）
dsh plugin --profile web add "github:yuna78/dsh-agent-tree"

# 从 Release 的 tgz 装（和 npm 上同一份内容，只下载运行需要的文件）
dsh plugin --profile web add \
  https://github.com/yuna78/dsh-agent-tree/releases/download/v0.1.2/dsh-plugin-agent-tree-0.1.2.tgz

# 本地开发（本仓库路径）
dsh plugin --profile web add "$PWD"
```

> 细节、卸载、排查见 [安装与配置](docs/install.md)；每块 UI 是什么意思见 [使用手册](docs/manual.md)。

## 怎么用

![一张 288px 的常驻小卡，把 dsh、workspace、对话、subagent 画成真树](docs/assets/screenshot.png?v=0.1.3)

| 你看到的 | 意思 |
|---|---|
| `🌳 Agent Tree Dock 1 待处理 🤖5 ⏰3 ⌃` | **收起后的胶囊**：icon + 插件名 + 三个计数——`1 待处理`（等你拍板）、`🤖5`（5 个 agent 在跑）、`⏰3`（3 个定时任务），为 0 的不显示；点一下（或 `Enter` / `Space`）展开，按住可拖动 |
| `● 1 待处理 · 5 在跑 · 2 定时` | 有 1 个会话在等你拍板（提问/审批/计划审阅），5 个在跑，2 个由定时任务驱动 |
| 窗口头 `💧` `↻` `—` | 换肤（颜料滴）/ 检查更新（转圈）/ 最小化；检查更新要你点一下才联网 |
| `├─ ● 智力研发团队 1  待答  v4.1-pro` | 这一行**要你决定**：琥珀色圆点 + `待答` 徽标，排在在跑的会话之前 |
| `▾ ● dsh  2 个 workspace` | 本机上的一个 agent：当前这个 DSH 实例，右上是它的 workspace 数 |
| `▾ ● dsh :3083  2 个会话 · 2 子代理` | 本机另一个 DSH 实例（你同时开了多个端口）：下面是它当前打开着的会话；行右边的 `2子` 是这会话挂的 subagent 数，`▸` 展开；点行在新标签打开 |
| `├─ ▾ proj-alpha  2` | workspace 分组，右上是它下面列出的分支数 |
| `├─ ▾ ● Refactor billing flow  ⏱8m  v4.1-pro` | 顶层对话在跑（绿点），8 分钟后有下一次定时，用 v4.1-pro |
| `│  ├─ ● Explore repo structure  v4.1-flash  1m5s` | 它的 subagent（蓝点），已跑 1 分 05 秒 |
| `│  │  └─ ● Run unit tests  v4.1-flash  9s` | 孙代理（紫点） |
| `▾ ● codex 推进一下能推进的任务…  devline` | codex 的**会话标题**（首条真实用户消息）+ 目录名；不是目录名兜底 |
| `▾ ● claude proj-alpha         12m 3%` | 本机另一个 agent（和 `dsh` 同级）：claude CLI，工作目录 `proj-alpha`，跑了 12 分钟、3% CPU |
| `│  └─ computer use ×2            41m` | 它的子进程，自动按种类归组（`×N` + 最长的那个时长） |
| `├─ ⏰ 推进 backlog 任务并设循环   now` | 挂了定时 / 循环任务的会话：标题前固定一个小闹钟，右侧是距下次触发的倒计时（到期显示 `now`，闹钟不消失） |
| `│  ├─ ● Hubble advance_review_logic  running` | codex 的子对话（subagent 线程）：昵称 + agent 路径，右边是「正在工作 / 最后活动多久前」 |
| `会话 6 · 子代理 3 · 运行中 5（live）` | 自检：快照里的会话数 / 子代理数 / 运行中数量；`live` 表示官方实时状态流 |

- 点任意一行 → 跳到对应会话（subagent 会跳到它自己的对话）。
- 点窗口头的转圈按钮 → 向 npm 查一次最新版：已是最新就显示版本号，有新版就显示版本号和升级命令（可一键复制）。
- 拖窗口头或胶囊 → 换位置；点窗口头右上角的「—」→ 收成胶囊，点胶囊 → 展开；`localStorage` 里的 `dsh-agent-tree:pos` 存位置。
- 卡宽度固定 288px，高度随内容自适应，最多 48 行。

## 换皮肤

![三套内置皮肤：默认 / 樱花 / 鲸鱼娘](docs/assets/screenshot-skins.png?v=0.1.3)

窗口头右上角、最小化按钮左边有一个**颜料滴按钮**，点开是三套内置皮肤：

| 皮肤 | 配色 | 细节 |
|---|---|---|
| 默认 | 跟随 DSH 主题 | 浅色白卡 / 深色深灰卡，不加任何装饰 |
| 樱花 | 粉白 + 樱色 | 标题层粉色 banner、重画的樱花 icon、粉色边框 / 阴影，2/3 层圆点转粉 / 紫；**一整枝樱花长在卡片外面** |
| 鲸鱼娘 | DeepSeek 蓝 + 海面渐变 | 蓝色 banner、重画的鲸鱼 icon、蓝色调的文字与计数；**浪花里的小鲸鱼从框外探出来** |

选择存在 `localStorage: dsh-agent-tree:skin`，收起后的胶囊也会跟着换（还会带一枚小装饰）。想自己做一套
（或者只微调几个颜色）：往 `window.__DSH_AGENT_TREE_SKINS__` 注册一组 CSS 变量和 `decor` 图片就行，完整的
变量表、icon / banner / 外框装饰写法和示例见 [皮肤指南](docs/skins.md)。

## 数据从哪来

全部走 DSH 客户端公开的 UI 契约，不 patch 宿主、不读数据库：

| 信息 | 来源 |
|---|---|
| 会话、父子关系 | `useSessions()` → `ids / byId`，行上的 `parentId`、`origin` |
| 实时 running | `useSessionStatus()`；拿不到全局 props 时回落到轮询快照 + `$on('api-session/status')` |
| workspace 归属 | `ctx.workspaces.list.getSnapshot()` |
| 耗时 / 模型 | `projectionValues.subagentTiming`、`projectionValues.modelSelection` |
| 定时任务 | `ctx.remote.schedule.catalog()` + `$on('schedule/changed')` |
| 本机其它 dsh 实例 | 宿主半部 `ps` + `lsof`（监听端口 / 打开着的 `~/.dsh/sessions/*/session-<id>/`） |
| 跳转 | `ctx.sessions.subagentAddress()` + `ctx.uiWorkspace.openSession()` |
| 外部进程 | 宿主半部 `GET /local/dsh-agent-tree/processes` |

## 外部进程监控：范围与边界

- **只读**：`ps -axo pid=,etime=,pcpu=,command=` + `lsof -a -p <pid> -d cwd -Fn`，不碰进程、不发信号、不读它输出。
- **只认真 CLI**：可执行文件 basename 必须精确是 `claude` 或 `codex`；ChatGPT.app 里的 `Codex Framework`
  助手 / crashpad 进程被排除（它们会误报成 8 条一样的记录）。
- **接口护栏**：同源、复用 DSH 连接层鉴权（未登录 401）、只读 GET（其它方法 405）、`ps`/`lsof` 都有超时、
  结果缓存 3 秒、最多返回 8 条；`webServer` 服务缺失时只 warn 跳过，不会阻断 DSH 启动。
- **平台**：macOS / Linux 可用；Windows 没有 `ps -axo` 语义，这段自然为空（树本身照常工作）。
- 想关掉：删掉 profile 里 `dsh-plugin-agent-tree` 这一项即可，客户端不受影响（进程段自动消失）。

## 兼容

| 项目 | 范围 |
|---|---|
| DSH | `>= 0.2.1-rc.2 < 0.3.0`（已验证 `0.2.1-rc.2`，Web profile） |
| Node.js | `^22.19.0 \|\| >= 24.0.0` |
| 平台 | DSH Web（客户端座位 `shell.overlay`）；外部进程段 macOS/Linux |

## 开发

```sh
npm test                              # 单测（树构建 / 模型 / 定时 / 进程解析）
npm run verify                        # 契约 + 座位 + 数据源 + 隐私 + 单测，全绿才算过
node scripts/build-public-bundle.mjs  # 生成公开仓内容（白名单 + 隐私扫描，0 命中才放行）
```

改 `client.js` 只需浏览器硬刷新；改 `index.js`（宿主半部）需要重启 `dsh`。

## License

[MIT](LICENSE)
