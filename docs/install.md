# 安装与配置

简体中文 · [English](install.en.md)

`dsh-plugin-agent-tree` 是 DSH Web 的客户端插件（外加一个很小的宿主半部）。它不是独立 App，
必须挂在 DSH 的 profile 上运行；装完的形态是 DSH Web 界面角落里的那张小卡片。

## 0. 前置条件

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | `^22.19` 或 `≥ 24` | 与 DSH 运行时一致 |
| pnpm | 10+ | DSH 用 pnpm 管理 profile 依赖 |
| DSH | `≥ 0.2.0-rc.2 < 0.3.0` | 已验证 `0.2.0-rc.2` 与 `0.2.1-rc.2`；用 npm 全局安装的发行版 |
| 一个 LLM provider | — | 插件本身不需要 key，但要能跑会话才有东西可看 |

```sh
npm i -g @deepseek-ai/dsh@latest   # 还没有才装；已经在跑 0.2.0-rc.2 / 0.2.1-rc.x 的不用升级
dsh --version
```

## 1. 装到新 profile（推荐，干净）

```sh
dsh --profile agent-tree --from-default-profile web
dsh plugin --profile agent-tree add dsh-plugin-agent-tree
```

启动：

```sh
dsh --profile agent-tree --port 13090
```

浏览器打开终端里打印的地址（带 token 的那个），卡片就在右下角。

## 2. 装到现有 profile

```sh
dsh plugin --profile web add dsh-plugin-agent-tree
# 然后重启你平时启动 dsh web 的那条命令
```

## 3. 其它安装方式

```sh
# Release 的 tgz（和 npm 上同一份内容；只拉运行需要的文件，不带 .git 历史）
dsh plugin --profile web add \
  https://github.com/yuna78/dsh-agent-tree/releases/download/v0.1.2/dsh-plugin-agent-tree-0.1.2.tgz

# GitHub 源码（带完整提交历史，适合要改代码的）
dsh plugin --profile web add "github:yuna78/dsh-agent-tree"

# 本地目录（开发用；改 client.js 刷新即可，改 index.js 要重启）
dsh plugin --profile web add "$PWD"
```

## 4. 必须做的一步：重启

插件有**宿主半部**（注册 `GET /local/dsh-agent-tree/processes` 进程探测接口），
所以 `dsh` 进程需要重启一次才会生效；重启后浏览器硬刷新（`Cmd/Ctrl + Shift + R`）。

只改 `client.js` 时不需要重启宿主，刷新页面即可（bundle 的 `rev` 是运行时计算的）。

## 5. 验证装好了吗

1. 打开 DSH Web，右下角出现一颗「胶囊」或展开的树状卡；
2. 起一个会话让它干活，卡片标题变成 `● 1 个 agent 在跑`；
3. 在终端跑 `claude --help` 或 `codex --help` 让它挂着，几秒后卡片底部出现 `● claude …` 行
   （说明宿主半部的进程接口通了）。

## 6. 升级

```sh
dsh plugin --profile web add dsh-plugin-agent-tree@latest
# 重启 dsh + 硬刷新
```

不想记命令：展开卡片，点窗口头中间那个**转圈按钮**，它会去 npm 查一次最新版；有新版就把上面这条命令显示出来，
点「复制命令」粘贴即可。检查只在点击时联网（只读 GET，不带 cookie）。

## 7. 卸载

```sh
dsh plugin --profile web remove dsh-plugin-agent-tree
# 重启 dsh
```

浏览器 `localStorage` 里会残留一个位置键 `dsh-agent-tree:pos`，卸载后无副作用；
想清掉就在浏览器控制台 `localStorage.removeItem('dsh-agent-tree:pos')`。

## 8. 排查

| 现象 | 原因 / 处理 |
|---|---|
| 根本没有卡片 | 没重启 dsh（宿主半部）/ 页面没硬刷新 / profile 里没这个包：`dsh plugin --profile web list` |
| 卡片在屏幕外面 | 拖回来即可；或清 `dsh-agent-tree:pos` 后刷新 |
| 卡片是空的（`空闲`） | 当前没有正在跑的会话、也没有 active 定时任务；起个会话或 `dsh` 里发一条消息 |
| 有 subagent 但树里没有 | 该会话不是 running 状态；或它属于别的 profile（本卡只显示当前 Web 实例的会话） |
| 底部没有 claude/codex 段 | 宿主半部没加载（没重启）/ 平台不是 macOS、Linux / 进程 basename 不是精确的 `claude`、`codex` |
| 市场「Add plugin」搜不到包 | 见 <https://github.com/yuna78/dsh-agent-tree#readme>；通常是市场夜间索引还没收录，或包名打错（是 `dsh-plugin-agent-tree`） |
| 启动日志有 `[dsh-agent-tree]` 警告 | 宿主半部在缺 `webServer` 时会 warn 并跳过接口，客户端照常工作 |
