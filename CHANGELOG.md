# Changelog

## 0.1.7 — 2026-11-01

- **桌面浮窗拖拽修好**：0.1.6 的页面 JS 拖动在 WKWebView 里不可靠（窗口未激活时第一下被
  「激活窗口」吃掉，表现就是拖着没反应）。现在头部 / 胶囊矩形由页面上报，原生
  `DragStripView` 直接 `performDrag` 拖整个窗口（未生效时退回手动跟踪鼠标兜底）；
  轻点一下才把 click 还给页面，胶囊展开 / 行点击照旧。头部三个按钮
  （换肤 / 检查更新 / 最小化）在拖区里开洞，仍归网页。右键菜单同时改成 AppKit 原生 `NSMenu`。
- **桌面浮窗一键启动**：新增 `bin.dsh-agent-tree-dock`（`desktop/dock-bin.mjs`），
  `npx -p dsh-plugin-agent-tree dsh-agent-tree-dock` 首次运行自动 `swiftc` 编译再拉起；
  之前装完插件没有明显入口（浮窗是独立进程，装插件不会自动出现）。
- **浮窗位置收敛 + 实例记忆**：恢复上次位置时整窗收进可见区域（换屏幕 / 分辨率变化不会把卡片
  切一半），拖到屏幕边缘贴边停住；多实例时记住上次选中的 origin 并优先复用（都活跃才换）。
- 文档补「在 DSH 里拖卡片拖不出窗口 = 物理边界，浮窗要单独启动」的排查项。

## 0.1.6 — 2026-11-01

- **桌面浮窗（macOS）：卡片跑出 DSH 窗口**。新增 `desktop/`——一个独立的小进程（AppKit + WKWebView，
  参照 dsh-maoxuan-pet 桌宠壳的做法），透明无边框置顶、跟随所有 Space，里面渲染的**就是 client.js 那套
  MiniInner 组件与皮肤**，和页内卡片一模一样。浏览器端卡片把裁剪后的渲染快照每秒 POST 给宿主
  （`POST /local/dsh-agent-tree/dock/state`，内存里只留一份最新帧）；壳带握手 token
  （`~/.dsh/agent-tree-dock-<端口>.json`，0600，DSH 重启自动轮换）轮询拉走注入浮窗页面——**浮窗页面全程零网络**。
  浮窗里点行 → `POST /local/dsh-agent-tree/dock/action` 排队 → 随下一次发布响应带回浏览器执行 `openSession`
  并把 DSH 带到前台；点卡片以外穿透到桌面；拖头部/胶囊挪窗口；右键 打开 DSH / 复位位置 / 退出。
  `npm run dock:build` 就地编译（swiftc，无第三方依赖），`npm run dock` 编译并拉起。
  快照经过裁剪（`dockPayload`），不带会话正文；详见 `docs/desktop.md`（英文 `docs/desktop.en.md`）。
- **按需求去掉外部 agent 的子进程归组行**：`computer use ×N` / `MCP ×N` / `code mode` / `helper` 这些行不再显示，
  客户端删除了 `groupProcessChildren` 与整段子进程渲染；外部 agent 行的折叠改由 codex 子对话（threads）驱动，
  tooltip 里的「N 个子进程」一并去掉。宿主半部 payload 仍带 `children` 字段（回滚只需恢复客户端渲染）。
- **修复：codex 不在 active 了还挂在面板上**。两个叠加原因：① ChatGPT / CodexCLI.app 的常驻后端
  `codex app-server` 的可执行文件 basename 恰好是 `codex`，被当成 CLI 根进程——只要 ChatGPT.app 开着它就永远
  活着，行就永远挂着（本机实测有一条跑了 6 天的这种进程）；② 客户端进程行的圆点硬编码 `active: true`，rollout
  早就停了也照样亮。现在：`isCodexBackend` 识别常驻后端（token 判定，旗标夹中间也抓得到），只在最近 10 分钟
  （`BACKEND_VISIBLE_MS`）有 rollout 写入时才挂行；`codexRowActivity` 给 codex 行算真实活动信号
  （认领 rollout 与子线程的最近写入，<120s 亮 / 否则灰），圆点跟随信号，hover 提示「最后活动多久前」。
- **修复：Claude 桌面版在 chat 里但没有 session**。`detectAgent` 只精确认小写 `claude`/`codex` basename，
  Claude 桌面版主进程 `/Applications/Claude.app/Contents/MacOS/Claude`（大写 C）与 `Claude Helper` 全部不命中，
  于是完全不显示。现在 `isClaudeDesktop` 识别主进程（路径含 `Claude.app/Contents/MacOS/`，Helper 与 Codex
  桌面辅助进程不误伤），按 `claude`（desktop）挂顶层节点，行名 `Claude 桌面版`，Helper 作为子进程挂树下。
- 宿主半部新增导出：`isCodexBackend` / `isClaudeDesktop` / `codexRowActivity` / `snapshot`（后两个给自检与排查用）。
- 文档：README（中/英）「外部进程监控」两处、docs/manual（中/英）外部 agent 一节同步新行为。

## 0.1.5 — 2026-10-31

- **向下兼容 DSH 0.2.0 线**：`engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh"]` 从 `>=0.2.1-rc.2 <0.3.0`
  放宽到 `>=0.2.0-rc.2 <0.3.0`。0.2.0-rc.2 上现在能正常安装、宿主行插入、客户端卡片渲染——0.1.4 及更早会被
  DSH 的兼容性门直接拒绝并原子回滚（`dsh: installation rejected: …`），这就是「别人用不了」的原因。
- **为什么要两处一起改**：0.2.0-rc.2 的 `evaluatePluginCompatibility`（`@deepseek-ai/dsh-app-boot`）**只读
  `peerDependencies`**，压根不看 `engines.dsh`；0.2.1+ 反过来，有 `engines.dsh` 就只认它、忽略 peer。
  只放宽一处，另一条线照样装不上。区间带 `-rc.2` 是必须的：DSH 用 `includePrerelease: true` 判定，而
  `>=0.2.1-rc.1 <0.3.0` 这种写法反而会静默排除 `0.2.1-rc.2`。
- **零代码分叉**：把 0.2.0-rc.2 与 0.2.1-rc.2 的依赖面逐项比对了一遍——`shell.overlay` 座位（list / root）、
  5 个客户端注入服务（`sessions` / `slots` / `workspaces` / `remote` / `uiWorkspace`）、标准槽 props
  （`useSessions` / `useSessionStatus`）、`api-session/status` 与 `schedule/changed` 事件、`projectionValues`
  的 `subagentTiming` / `modelSelection`、宿主 `webServer.register` 与 `connection.requestRejection` ——
  签名和语义都一致，没有任何 `if (version)` 兼容代码。
- **实测（0.2.0-rc.2，隔离环境，2026-10-31）**：`npm i --prefix /tmp/dsh020 @deepseek-ai/dsh@0.2.0-rc.2` +
  独立 `DSH_HOME`；`dsh plugin add` 无 `allow-version` 豁免直接成功；`dsh --profile web --port 3199` 启动无
  `[dsh-agent-tree]` 警告；`GET /local/dsh-agent-tree/processes` 未登录 401 / 带 cookie 200（真实 JSON）/
  错误兄弟路径 404；前端 module manifest 含 `dsh-plugin-agent-tree/client.js`（bundle HTTP 200）；headless
  Chromium 里 `div.dsh-agent-tree-root.dsh-agent-tree-pill` 正常渲染、无 pageerror。0.2.1-rc.2 同样回归通过。
- **已知退化**：0.2.0-rc.2 的 shipped `web` 模板没带 schedule bundle，`/api/schedule/catalog` 404，
  定时任务倒计时不显示（客户端静默降级，其它功能不受影响）。
- `verify/smoke.mjs` 新增版本门回归：两处范围必须相等，且必须收下 `0.2.0-rc.2` / `0.2.1-rc.x`、
  挡掉 `0.1.x` 与 `0.3.0`（内置一个最小 semver 子集，不引依赖）。
- 文档：`docs/compat.md` 重写（支持范围 / 两条版本门 / 0.2.0-rc.2 实测记录）；安装文档与 README 的前置版本同步。

## 0.1.4 — 2026-10-31

- **新皮肤：鲸鱼娘·小姑娘**——手绘 Q 版小姑娘（天蓝双马尾、鲸鱼尾巴发饰、水手领、腮红），从卡片右上角探出
  头来，收起成胶囊时也坐在胶囊边上。素材是真正的手绘插画（即梦生成的透明底 WebP，切成 619×602 后 base64
  内嵌进 `client.js`），不是被重新上色的 icon。
- **新皮肤：竹林 / 兰花**——水彩翠竹从卡片左右两侧长出来、竹叶伸到框外；兰花一丛探出右上角、一丛从左下角长出。
  两套都带草绿 / 淡紫的完整变量组（浅色 + 深色）和重画的 icon（竹竿 + 竹叶 / 五瓣兰）。
- **去掉上一版的机器猫 / 小恐龙**：这两套是纯 SVG 手搓的，效果不够好，换成上面的竹林 / 兰花。
- **窗口头三个按钮收紧**：换肤 / 检查更新 / 最小化之间只留 2px 间距（`gap: 8px` 里扣掉 6px），不再松松垮垮。
- **换肤 icon 换成小 T 恤**：之前的颜料滴 / 画笔在 11px 下都不够「像皮肤」，T 恤 = 换衣服，语义更直白。
- 皮肤对比图（浅色 / 深色）按六套皮肤重拍，README 首图换成「樱花 + 小姑娘 + 竹林」+ 三颗胶囊的整组渲染。
- 文档：`docs/skins.md` / `docs/skins.en.md` 的内置皮肤表、icon 列表、内置 `key` 列表都补到六套；使用手册的
  「颜料滴按钮」统一改成「小 T 恤按钮」。

## 0.1.3 — 2026-10-31

- **皮肤外框装饰（QQ 皮肤那种）**：皮肤现在能带真正的透明底插画素材，渲在卡片**外面、窗口后面**，只露出伸出去的
  那一部分——樱花是一整枝从左上 / 左下长出来，鲸鱼娘是从右上探出来的浪花小鲸鱼 + 左下浪花；收起成胶囊时也会贴一枚
  小装饰。素材是内置的透明 SVG（`data:image/svg+xml`），DIY 皮肤可以用 `decor: [{ src, x, y, w, rot, opacity, flip, anchor }]`
  换成自己的 PNG / WebP / SVG（只收 data URI，最多 4 张，见 `docs/skins.md`）。
- **icon 重画**：樱花改成带缺口的 5 瓣花、鲸鱼改成圆头 + 尾鳍 + 喷水，换肤按钮从「调色盘」换成更清楚的**颜料滴**；
  窗口头三个 ghost 按钮（颜料滴 / 转圈 / 最小化）缩到 22px、图标 11px、颜色从深灰降到 `--dat-muted`，不再发黑。
- **检查更新按钮**：展开态窗口头多了一个转圈按钮（最小化左边），点一下才向 `registry.npmjs.org/.../latest` 发一次
  只读 GET：转圈 → 展示「已是最新 vX」或「发现新版本 vX」；有新版时面板里给一条可复制的
  `dsh plugin --profile web add dsh-plugin-agent-tree@latest`，按钮上再挂一个小圆点。结果缓存 30 分钟，不自动轮询，
  是全插件唯一的联网点（README 的隐私说明已注明这个例外）。
- **文档图片更新**：README 首页换成「展开 + 收起 + 换肤胶囊」的整组渲染图，卡片图、皮肤对比图（浅色 / 深色）按新版
  UI（三个按钮 + 外框装饰）重拍。
- **皮肤框架（可 DIY）**：窗口头新增换肤按钮，内置 **默认 / 樱花 / 鲸鱼娘** 三套皮肤——每套带自己的卡片底色、
  标题层 banner、icon、边框 / 阴影（frame）和胶囊配色，深色模式各有暗色变量；选择存 `localStorage: dsh-agent-tree:skin`，
  收起后的胶囊同样套用。自己加一套不用改代码：往 `window.__DSH_AGENT_TREE_SKINS__` 注册一组 `--dat-*` CSS 变量即可
  （只认识的变量才收、能提前闭合声明的值会被丢掉，内置皮肤不能被顶掉），完整的变量表和 icon / banner 写法见 `docs/skins.md`。
- **本机其它实例只列在干活的会话**：有本地实时状态就听状态（在跑 / 等你拍板），没有就按「最近 5 分钟内有活动」判断；
  几小时前停着的会话、以及整个没有活儿的实例节点都会收掉，卡不会被别的端口的历史会话撑长。
- 文档：README / 使用手册新增皮肤章节，新增 `docs/skins.md` + `docs/skins.en.md` 和皮肤对比图 `docs/assets/screenshot-skins.png`。
- **plugin dock 式窗口头**：卡片顶部多一层——左边是插件 icon + 名字 **Agent Tree Dock**，下面一行状态副标题
  （`1 待处理 · 5 在跑 · 3 定时`，前缀状态点），右边是换肤 / 检查更新 / 最小化三个无底色 ghost 图标按钮，
  静止时只有浅灰图标，hover 才出现浅底，`Tab` 可聚焦并带 `focus-visible` 描边。
- **收起态胶囊带三个计数**：胶囊现在是 `🌳 Agent Tree Dock　1 待处理　🤖5　⏰3　⌃`——琥珀 `N 待处理`（等你拍板）、
  绿色单色机器人 `🤖N`（N 个 agent 在跑）、单色闹钟 `⏰N`（N 个定时任务）；三个计数各自只在非零时出现，
  空闲时只剩 icon + 名字 + 展开箭头。34px 高、`border-radius:999px`，hover 上浮 + 阴影加深 + 箭头底衬，
  进出场 160ms 动效，`prefers-reduced-motion` 下全部关掉。
- 点胶囊（或 `Enter` / `Space`）展开；拖动阈值 4px，拖动不会误触展开；收起态拖动会按胶囊实际宽度重新夹在视口内；
  卡片和胶囊都加了 `touch-action:none`，触屏拖动不会被当成页面滚动。
- 空闲时窗口头副标题显示「空闲 · 没有在跑的任务」，不再和标题重复。
- 卡片圆角 10 → 14，阴影改用 DSH 的 `--dsw-elevation-panel`（跟随主题），标题层 / 行 / 胶囊配色统一走 `--dsw-alias-*` 令牌。
- 文档：README / 使用手册 / 安装文档同步新窗口头与计数胶囊；`docs/assets/screenshot-capsule.png` 换成「展开 vs 三种胶囊状态」
  对比图，主截图更新到新 UI。

## 0.1.2 — 2026-10-29

- **本机多个 dsh 实例**：同时开多个 `dsh web --port 30xx` 时，别的实例里正在跑的会话也会出现在卡上。
  每个实例是一个顶层节点（`dsh :3083`），右上角是「会话数 · subagent 数」，下面是它当前打开着的会话
  （标题取自共用的会话目录，按 `parentId` 数出每个会话挂了多少 subagent，`▸` 可展开看是哪几个），点一下在新标签打开那个实例。
  宿主半部用 `ps` + `lsof` 读监听端口与打开的会话文件，不需要跨实例接口/鉴权。
- 修：实例侧的会话 id 少了 `session-` 前缀，和客户端会话表对不上，导致节点显示「0 个会话」且不能下钻。
- 修：`lsof` 超时 1.5s → 4s；真认不出的会话显示「N 个会话（不在本实例）」而不是 `0 个会话`。

## 0.1.1 — 2026-10-29

- **定时 / 循环任务加小闹钟**：挂了定时任务的会话，标题前固定有一个 `⏰`，右侧显示距下次触发的倒计时（`8m` / `2h` / `3d`）。
  刚触发过、倒计时到期的显示 `now`，但 `⏰` 不会消失——之前只有「还没到点」的行才有标记，正在跑或刚跑完的循环任务看起来和普通会话一样。
- 倒计时不再重复画 `⏱` 图标：图标统一挪到标题前，右侧只留数字。

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
