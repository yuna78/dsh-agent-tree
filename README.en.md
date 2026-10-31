# Agent Tree · a mini live tree of every DSH agent

[简体中文](README.md) · English

![Agent Tree: expanded it is a 288px card, collapsed a capsule — and skins really grow outside the dock](docs/assets/screenshot-capsule.png?v=0.1.4)

**Agent Tree** is a small observability plugin for the DeepSeek Harness (DSH) Web UI: a **288px wide floating card**
in a corner that draws `dsh → workspace → conversation → subagent → grandchild` as a live tree with
`git log --graph`-style connectors. Only branches that are **running or scheduled** are shown, so the card stays small;
when nothing is happening it collapses to a **round capsule** — and it never disappears.

It solves one concrete annoyance: with many conversations open you have to click into each one to see what its
subagents are doing. The DSH sidebar lists conversations, not agent lineage. This card shows **who is running,
at which depth, on which model, for how long, and when its next scheduled run fires**.

![Inside the DSH page: a small always-on card in the bottom-right corner, with the sakura branch growing outside the dock (sample data)](docs/assets/screenshot-app.png?v=0.1.4)

## Features

- **The top level is an agent list** — `dsh` (this instance) and the local `claude` / `codex` processes are **siblings**, each expanding its own tree: `dsh → workspace → conversation → subagent → grandchild`, with `├─ └─ │` indentation and `▾ / ▸` collapse.
- **Plugin-dock style window header** — plugin icon + the name **Agent Tree Dock** on the left, a status subline (`1 待处理 · 5 在跑 · 3 定时`) underneath, and three ghost icon buttons on the right: **paint drop** (skins), **spinner** (update check) and **—** (minimise). They sit in a soft grey at rest and only pick up a faint tint on hover.
- **Always-on entry (capsule)** — idle collapses to a round capsule `🌳 Agent Tree Dock 1 待处理 🤖5 ⏰3 ⌃`. Each counter appears only when non-zero: amber `N 待处理` (waiting for your call), green robot `🤖N` (N agents running), monochrome clock `⏰N` (N scheduled tasks). When fully idle it is just icon + name + chevron. Click the capsule (or `Enter` / `Space`) to expand, drag to move; manual collapse wins over auto-expand.
- **Skins (DIY, old-QQ style)** — a little T-shirt button switches skins: **Default / Sakura / Whale girl / Whale girl · chibi / Bamboo grove / Orchid** ship built in, each with card
  surface, header banner, redrawn sakura / whale icons, frame and capsule colours plus dark-mode values. Sakura and Whale girl also carry
  **real transparent illustration assets** (a whole sakura branch, a baby whale in its splash) rendered *outside* the card and *behind* it,
  so they look like they grow out of the dock; the collapsed capsule gets a small sprig too. Adding your own needs no code changes: register
  `--dat-*` variables plus a `decor` image list on `window.__DSH_AGENT_TREE_SKINS__` — see the [skin guide](docs/skins.en.md).
- **Color = depth** — green dot for top-level conversations, blue for level-2 subagents, violet for deeper ones, grey for finished rows.
- **Per-row model chip** (right aligned) — from the session projection `modelSelection` (`next` → `lastUsed`), shortened to `v4.1-flash`; subagents without their own record inherit the parent's (tooltip says so).
- **Multiple local dsh instances** — when you run several `dsh web --port 30xx` at once, sessions live in the other instances
  show up too: one top-level node per instance (`dsh :3083`) labelled with its session / subagent counts, listing only the sessions that
  are **still working** (or waiting for your call) — stale sessions and instances with nothing active are dropped; each row shows how many
  subagents hang off it (`▸` expands them), click to open that instance in a new tab. The host half discovers ports and sessions via
  `ps` + `lsof` on local files, so no cross-instance auth is needed.
- **Alarm clock on loop sessions** — any session driven by a schedule keeps a `⏰` in front of its title, with the countdown to the next run on the right (`8m` / `2h` / `3d`); a round that just fired shows `now` and still keeps the clock, so a running loop never looks like a plain conversation.
- **Scheduled-task countdown** — reads `schedule.catalog()` from Automation tasks (the `remote.schedule` service, with a `ctx.get` fallback while its namespace is not mounted yet); sessions driven by a schedule are listed even while idle, with `⏱8m / ⏱2h / ⏱3d` and a `N running · M scheduled` headline.
- **Sessions that need your call come first** — when an agent asks a question, waits for an approval, or waits for a plan review (`pendingInteraction` = `question` / `approval` / `plan-review`), that row turns **amber**, carries a `待答 / 待批 / 待审` badge and **sorts above running rows**. Previously such a session disappeared because it was no longer running.
- **Local external agent processes, also as a tree** — the plugin's host half exposes a read-only endpoint that finds running **claude / codex CLIs** via `ps` + `lsof` and nests their children by `ppid` (e.g. codex's `computer use ×4` / `MCP ×3` / `code mode`). They show up as **top-level agents next to `dsh`**, with exactly the same row spec. ChatGPT desktop's `Codex Framework` helpers are not mistaken for CLIs themselves.
- **codex rows are named after their own session** — the first *real* user message from the rollout (skipping `environment_context` / `AGENTS.md` injections), e.g. `codex 推进一下能推进的任务…  devline`, falling back to the directory name; processes sharing one cwd claim distinct sessions, so rows never share a name.
- **codex sub-conversations are visible too** — reads codex's own session records (`~/.codex/sessions/**/rollout-*.jsonl`, first `session_meta` line) and rebuilds its subagent threads by `parent_thread_id`, hanging them under the codex row: `● Hubble advance_review_logic running` / `● Carson review_nextarchive_code 16m前`. Local read-only, no network, nothing leaves the machine. (Claude's sidechain layout differs and is not parsed yet.)
- **Click to jump** — `subagentAddress()` + `uiWorkspace.openSession()`, including subagents.
- **Draggable, remembers its position** — stored in `localStorage`.

## Install in 3 minutes

Prerequisites: Node.js `^22.19 or ≥ 24` (same as the DSH runtime), pnpm 10+, DSH `≥ 0.2.1-rc.2 < 0.3` (verified on `0.2.1-rc.2`).

```sh
# 1) a dedicated profile (or reuse your existing web profile)
dsh --profile agent-tree --from-default-profile web

# 2) install from npm
dsh plugin --profile agent-tree add dsh-plugin-agent-tree

# 3) start
dsh --profile agent-tree --port 13090
```

**Restart `dsh` once after installing** (the host half registers the process endpoint), then hard-refresh the browser (`Cmd/Ctrl + Shift + R`).

```sh
# existing profile
dsh plugin --profile web add dsh-plugin-agent-tree
# from GitHub source
dsh plugin --profile web add "github:yuna78/dsh-agent-tree"
# local development
dsh plugin --profile web add "$PWD"
```

> Details, uninstall and troubleshooting: [docs/install.en.md](docs/install.en.md). What every element means: [docs/manual.en.md](docs/manual.en.md).

## Reading the card

![Collapsed: a round capsule — click to expand; the prominent minimize button sits in the card header](docs/assets/screenshot-capsule.png?v=0.1.4)

| What you see | Meaning |
|---|---|
| `🌳 Agent Tree Dock 1 待处理 🤖5 ⏰3 ⌃` | **collapsed capsule**: icon + name + three counters — `1 待处理` (waiting for you), `🤖5` (5 agents running), `⏰3` (3 scheduled tasks); zero counters are hidden. Click it (or `Enter` / `Space`) to expand, drag to move |
| `● 5 个 agent 在跑 · 2 定时` | 5 sessions/subagents are running; 2 more are schedule-driven (may be idle right now) |
| `▾ ● dsh  2 个 workspace` | one local agent — this DSH instance; workspace count on the right |
| `├─ ▾ proj-alpha  2` | workspace group, count on the right |
| `├─ ▾ ● Refactor billing flow  ⏱8m  v4.1-pro` | top-level conversation running (green), next scheduled run in 8 min, on v4.1-pro |
| `│  ├─ ● Explore repo structure  v4.1-flash  1m5s` | its subagent (blue), running for 1m05s |
| `│  │  └─ ● Run unit tests  v4.1-flash  9s` | grandchild agent (violet) |
| `├─ ● claude  proj-alpha        12m 3%` | a local claude CLI process in `proj-alpha`, 12 min, 3% CPU |
| `会话 6 · 子代理 3 · 运行中 5（live）` | self-check line: sessions / subagents / running; `live` = official realtime status stream |

The UI strings are Chinese for now (DSH itself is Chinese-first); a locale pass is welcome — the copy lives in one
`labels` object in `client.js`.

Click a row to jump to that session; drag the header to move the card; click `▾/▸` to collapse. Click the **spinner** button in the header to check npm once for the latest release (`latest` is cached for 30 minutes); a small dot appears on the button when an update exists.

## Skins

![Six built-in skins: default / sakura / whale girl / whale girl · chibi / bamboo / orchid](docs/assets/screenshot-skins.png?v=0.1.4)

Left of the minimise button in the header there is a **palette button**. It opens the built-in skins:

| Skin | Palette | Details |
|---|---|---|
| Default | follows the DSH theme | plain white / dark card, no decoration |
| Sakura | pink + rose | pink banner on the header, sakura icon, rose border / shadow, level-2/3 dots turn pink / violet |
| Whale girl | DeepSeek blue + sea gradient | blue banner, whale icon, blue-tinted text and counters |
| Whale girl · chibi | sky blue + soft pink | hand-drawn chibi girl (twin tails, whale-tail hairpin, sailor collar) **peeks over the top-right corner**, rides on the capsule |
| Bamboo grove | leaf green + bamboo | watercolour bamboo; **two stalks grow out of the left and right edges**, leaves beyond the frame |
| Orchid | lavender + pink | orchid clumps; **one peeks over the top-right, one grows out of the bottom-left** |

The choice is stored in `localStorage: dsh-agent-tree:skin` and the collapsed capsule follows it too (with a small decoration).
To build your own (or just tweak a few colours), register CSS variables plus a `decor` list on `window.__DSH_AGENT_TREE_SKINS__` —
the full variable table, icon / banner / decoration recipes and an example are in the [skin guide](docs/skins.en.md).

## Where the data comes from

Only public client-side UI contracts — no host patching, no database access:

| Info | Source |
|---|---|
| sessions + parent/child | `useSessions()` → `ids / byId` (`parentId`, `origin`) |
| live running state | `useSessionStatus()`; falls back to polling + `$on('api-session/status')` |
| workspace ownership | `ctx.workspaces.list.getSnapshot()` |
| duration / model | `projectionValues.subagentTiming`, `projectionValues.modelSelection` |
| scheduled tasks | `ctx.remote.schedule.catalog()` + `$on('schedule/changed')` |
| jumping | `ctx.sessions.subagentAddress()` + `ctx.uiWorkspace.openSession()` |
| external processes | host half: `GET /local/dsh-agent-tree/processes` |

## External process monitoring: scope and limits

- **Read-only**: `ps -axo pid=,etime=,pcpu=,command=` + `lsof -a -p <pid> -d cwd -Fn`. No signals, no output capture.
- **Real CLIs only**: the executable basename must be exactly `claude` or `codex`; ChatGPT desktop helper processes are excluded.
- **Endpoint guards**: same-origin, reuses DSH connection auth (401 without a session), GET only (405 otherwise), timeouts on `ps`/`lsof`, 3s cache, max 8 rows; if the `webServer` service is missing it only warns and never blocks DSH startup.
- **Platforms**: macOS / Linux. On Windows the block stays empty (the tree itself still works).
- Disable it by removing the plugin from the profile — the client card simply loses that section.

## Compatibility

| Item | Range |
|---|---|
| DSH | `>= 0.2.1-rc.2 < 0.3.0` (verified `0.2.1-rc.2`, Web profile) |
| Node.js | `^22.19.0 \|\| >= 24.0.0` |
| Platform | DSH Web (client seat `shell.overlay`); process block macOS/Linux |

## Development

```sh
npm test                              # unit tests (tree / model / schedule / process parsing)
npm run verify                        # package contract + seats + data sources + privacy + tests
node scripts/build-public-bundle.mjs  # whitelisted public copy with a privacy scan
```

Editing `client.js` needs only a hard refresh; editing `index.js` (host half) needs a `dsh` restart.

## License

[MIT](LICENSE)
