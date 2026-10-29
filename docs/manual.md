# 使用手册：这张卡怎么读

简体中文 · [English](manual.en.md)

```
┌──────────────────────────────────────────────────┐
│ ● 5 个 agent 在跑 · 2 个定时                  ▾  │ ← 头部：统计 + 折叠
├──────────────────────────────────────────────────┤
│ ▾ ● dsh                          2 个 workspace  │ ← 顶层 agent：这个 DSH 实例
│ ├─ ▾ proj-alpha                              2  │ ← workspace
│ │  ├─ ▾ ● Refactor billing flow  ⏱8m  v4.1-pro  │ ← 对话（绿点）
│ │  │  ├─ ● Explore repo structure      1m5s     │ ← subagent（蓝点）
│ │  │  │  └─ ● Run unit tests              9s     │ ← 孙代理（紫点）
│ │  │  └─ ● Write migration plan          31s     │
│ │  └─   Fix flaky login test      ⏱2h  v4.1-flash │ ← 有定时、当前空闲
│ ├─ ▾ my-repo                                 1  │
│ │  └─ ● Triage CI failures        v4.1-pro       │
│ ▾ ● claude  proj-alpha                 12m 3%    │ ← 顶层 agent：本机 claude（和 dsh 同级）
│ │  └─ computer use ×2                    41m     │ ← 它的子进程（按种类归组）
│ ▾ ● codex   ChatGPT                 69h35m 2%    │
│ ├─ MCP ×2                                2h50m   │
│ ├─ computer use ×2                        41m    │
│ └─ code mode                              41m    │
│ 会话 6 · 子代理 3 · 运行中 5（live）             │ ← 自检行
└──────────────────────────────────────────────────┘
```

## 1. 头部

| 文案 | 含义 |
|---|---|
| `● 5 个 agent 在跑 · 2 个定时` | 5 个会话/子代理处于 running；另有 2 个会话有 active 定时任务 |
| `空闲 · 2 个定时待命` | 没有正在跑的，只有定时任务等着 |
| `● Agent 树 ▸` | 收起状态（只有一行） |
| 右侧 `▾ / ▸` | 手动展开 / 收起；手动操作优先于自动折叠 |

自动折叠规则：`running === 0 && scheduled === 0` 时收起；一旦有活儿自动展开（除非你手动收起了）。

## 1.4 需要你拍板的会话

agent 提问（`ask_user_question`）、等你批准一次操作、等你审阅计划时，会话会停在「等输入」状态，不算在跑。
卡片把这类会话**放在最上面**，并换成琥珀色 + 小徽标：

```
├─ ● 智力研发团队 1            待答   v4.1-pro
│  └─ ● 计划审阅               待审
```

- `待答`：agent 提了问题，等你选/答。
- `待批`：等你批准一次操作（命令、写文件、联网等）。
- `待审`：等你审阅计划（plan review）。

这类行排在「在跑」之前，所以永远不会因为「没在跑」被折叠掉；标题栏也会变成
「N 个等你处理 · M 个在跑 · K 个定时」。

## 1.5 层级

**顶层是「本机上的 agent」列表**：`dsh`（这个实例）和每个外部 `claude` / `codex` 是同级节点，
各自往下展开：

```
dsh（这个实例）                  claude / codex（本机其它 agent）
└─ workspace                     └─ 子进程（按种类归组）
   └─ 对话
      └─ subagent
         └─ 孙代理 …
```

所以从 `dsh` 往下是 4 层（workspace → 对话 → subagent → 孙代理），每个顶层 agent 都可以单独折叠。

## 2. 树行元素

从左到右：

| 元素 | 含义 |
|---|---|
| `├─ └─ │` | git log 风格连接线，表示层级；每深一层多三格缩进 |
| `▾ / ▸` | 这一行有子代理，可展开 / 已收起 |
| `●` | 状态点：颜色见下表 |
| 标题 | 会话标题（`displayTitle`），过长省略；运行的会话字更粗更深 |
| `⏱8m` | 定时任务的倒计时：`now` / `<1m` / `8m` / `2h` / `3d` |
| `v4.1-flash` | 模型标签（右侧对齐）：来自 `modelSelection`，`deepseek-` / `anthropic-` 前缀会去掉 |
| `1m5s` | 运行或已运行时长（subagent 行才有）：`45s` / `12m` / `1h5m` |

## 3. 颜色

| 颜色 | 含义 |
|---|---|
| 绿点 | 顶层对话在自己的会话里跑 |
| 蓝点 | 第 2 层 subagent |
| 紫点 | 第 3 层及更深（孙代理……） |
| 灰点 / 浅字 | 已结束，但为了让层级完整仍保留的行 |
| 橙点 / 绿点（底部段） | claude 进程 / codex 进程 |

## 4. 模型标签的继承

subagent 的 `modelSelection` 常常为空，这时用最近一个祖先会话的模型，悬停会显示「继承自上级」。
所以「这一行用的是哪个模型」永远有答案，不会留白。

## 5. 定时任务行

DSH 的 Automation tasks（`schedule.catalog()`）驱动的是「间歇式工作」的会话：它们大部分时间空闲，
到点自己跑一次。卡片会把这些会话**即使不在跑也列出来**，右侧 `⏱` 是下一次触发时间；
点它同样能跳过去看上一次跑出来的东西。

## 6. 本机外部 agent（和 dsh 同级）

宿主半部的只读探测，列出本机正在跑的 `claude` / `codex` CLI。它们**和 `dsh` 一样是顶层节点**
（同一套行规格：同样字号、同样圆点、同样折叠），区别只有圆点颜色（claude 橙 / codex 绿）：

```
▾ ● claude  proj-alpha        12m 3%
▾ ● codex   ChatGPT        69h35m 2%
```

- `label` 的取值顺序：进程真实 cwd 的目录名 → 命令行里的 `--cwd/--cd/-C` → `ChatGPT`（桌面端 backend）→ 空。
- 只显示前 8 条；结果缓存 3 秒；接口需要登录态（未登录 401）。
- 目的是「我在 DSH 里干活时，本机还有没有别的 agent 在偷偷跑」；点这一行可折叠子树。

### 6.1 外部 agent 的子进程

`claude` / `codex` 的子进程按 `ppid` 挂成子树；同一种子进程会归组成一行：

```
├─ ▾ ● codex  ChatGPT        69h35m 2%
│  ├─ MCP ×2                    2h50m
│  ├─ computer use ×2             41m
│  └─ code mode                   41m
```

- `×N` 表示有几个同类子进程，右侧显示其中跑得最久的时长；
- 点进程根行可以折叠它的子树；
- 子孙里如果又是一个真正的 agent CLI，会单独作为根出现，不重复挂。

### 6.2 codex 的子对话（subagent threads）

codex（CLI 和 ChatGPT 桌面端）每开一个会话都会写一条 rollout：`~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl`。
第一行是 `session_meta`，里面就有 `thread_source: subagent`、`parent_thread_id`、`agent_nickname`、`agent_path`。
插件只读这些头部、按 `parent_thread_id` 串成树，挂在 codex 那一行下面：

```
▾ ● codex ChatGPT              69h35m 2%
   ├─ ● Hubble   advance_review_logic       running
   ├─ ● Carson   review_nextarchive_code    16m前
   ├─ ● Wegener  review_nextarchive_triage  1h42m前
   ├─ MCP ×2                                2h50m
   └─ computer use ×2                        41m
```

- 2 分钟内活动过标 `running`（绿点加粗），否则显示「最后活动多久前」。
- 找的是哪条主会话：先按进程 cwd 匹配，worktree 里跑的就取 cwd 互为前缀的那条；
  ChatGPT 桌面端进程 cwd 常常是 `/`，这时优先挑 `originator` 带 `Desktop` 的会话。
- 最多 8 个子对话、最深 3 层。只读本机、不联网、不外发。

### 6.3 codex 那行的名字

行名不是目录名，而是**这条 codex 会话的第一句真实需求**（跳过 codex 自己塞的 `environment_context`、
`AGENTS.md instructions` 这类上下文），后面跟一个灰色的目录小标签：

```
▾ ● codex 推进一下能推进的任务，看看流水线…   devline   69h35m 2%
```

- 取不到（rollout 刚建、还没写用户消息）才回落到目录名 / `ChatGPT`。
- 同一 cwd 下有多个 codex 进程时，按时间各认领一条会话，所以不会出现两行同名。

## 7. 交互

| 操作 | 效果 |
|---|---|
| 点一行 | 跳到该会话（subagent 会落到它自己的对话） |
| 点 `▾/▸` | 折叠 / 展开该节点的子代理 |
| 拖标题栏 | 移动卡片，位置存 `localStorage: dsh-agent-tree:pos` |
| 点头部 `▾/▸` | 收起 / 展开整张卡 |

## 8. 刷新节奏

| 数据 | 频率 |
|---|---|
| running 状态 | 官方实时事件 `api-session/status`（`live`）；拿不到时 1s 轮询快照（`poll`） |
| 定时任务 | 事件 `schedule/changed` + 15s 轮询兜底 |
| 外部进程 | 5s 一次（宿主侧再缓存 3s） |
| 倒计时 / 时长 | 每秒重算显示 |

## 9. 自检行

`会话 N · 子代理 M · 运行中 K（live|poll）`

- `N` 是快照里能看到的会话数，`M` 是其中 `origin: subagent` 的数量；
- `K` 是判定为 running 的数量；
- `live` 表示用的是官方实时事件，`poll` 表示回落到了轮询 —— 如果长期是 `poll`，说明这个 DSH 版本的全局
  props 里没有状态 store，可以据此提 issue。

## 10. 已知限制

- 只显示**当前 Web 实例**的会话（别的 profile / 别的机器看不到）。
- 运行状态以 DSH 的状态事件为准；如果某个子代理在 DSH 里已经结束、但事件还没到，可能短暂多显示一两秒。
- 卡宽固定 288px，超长标题会省略；想加宽改 `client.js` 顶部的 `WIDTH`。
- UI 文案暂时是中文。
