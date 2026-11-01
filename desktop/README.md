# 桌面浮窗（macOS）

把 Agent Tree 卡片从 DSH 窗口里「搬」到桌面：一个独立的小进程，透明无边框、置顶、
跟随所有 Space。卡片本体和 DSH 页内那张**是同一套 React 组件与皮肤**（复用 client.js 的
MiniInner），所以长得一模一样；区别只是它跑在 dsh 窗口之外，任何应用在前台都看得到。

```
DSH 页面（浏览器）                       桌面壳（本目录产物）
┌─────────────────────────┐            ┌──────────────────────────────┐
│ client.js 每秒 POST 快照 │ ──────────▶│ GET /dock/state（带 token）轮询 │
│                         │            │        │ 注入 dock.html        │
│ openSession ◀───────────┼────────────┤ MiniInner 渲染（零网络）        │
│        ▲ 排队 action     │ ◀──────────│ 点行 → POST /dock/action       │
└─────────────────────────┘            └──────────────────────────────┘
```

## 使用

```bash
npm run dock:build          # swiftc 编译 + 收集 dock.html/css/js、client.js、vendor/ 到 desktop/build/
./desktop/build/dsh-agent-tree-dock
# 或者一步：npm run dock
```

前提：本机有一个装了 dsh-plugin-agent-tree 的 dsh 实例在跑，且它的 web 页面在某个浏览器里
打开着（快照是浏览器端发布的；页面没开时浮窗显示「等待 DSH 页面连接…」）。

壳启动时读 `$DSH_HOME`（默认 `~/.dsh`）里的 `agent-tree-dock-<port>.json`
（宿主插件启动时写的握手文件，权限 0600，只含 origin / port / token）。
多个实例时取最新的一个；也可以手动指定：

```bash
./desktop/build/dsh-agent-tree-dock --origin=http://127.0.0.1:51638
./desktop/build/dsh-agent-tree-dock --port=51638 --token=<握手文件里的 token>
./desktop/build/dsh-agent-tree-dock --verbose   # 轮询/布局日志打 stderr
./desktop/build/dsh-agent-tree-dock --reset     # 忽略上次记住的窗口位置
```

交互：

- **拖动**：按住卡片头部或胶囊拖整个窗口（位置记在 `UserDefaults`）；
- **点行**：把 DSH 应用带到前台并打开那条会话（action 经宿主排队，由浏览器端执行）；
- **右键**：打开 DSH / 复位位置 / 退出浮窗；
- **点空白**：穿透到桌面（只有卡片/胶囊/菜单矩形可点）；
- **收起**：和页内一样点胶囊；窗口高度会跟着卡片内容变。

## 它安全吗

- 渲染页加载的是本地 `file://` 文件，**全程零网络**：所有数据由壳轮询后注入；
- 壳对宿主的请求只带握手文件里的 token，文件 0600 只有当前用户可读；
- 快照在宿主里只存内存（一份最新帧），壳不落盘、不外发；
- 行数/字段都做过裁剪（`client.js` 的 `dockPayload`），不带会话正文。

## 已知边界

- 只在 macOS 编译运行（AppKit + WebKit）；Windows/Linux 的等价壳（Tauri / GTK）
  什么时候想要再说；
- 皮肤在浮窗里独立存储（WKWebView 是 nonPersistent data store，重启会回到默认皮肤），
  页内卡片换肤不会同步过去——想要同款在浮窗里再换一次即可；
- 快照延迟约 1 秒（发布器节拍），页内卡片是实时的，浮窗是「准实时」。

更多细节见 `docs/desktop.md`（英文版 `docs/desktop.en.md`）。
