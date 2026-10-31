# Manual: how to read the card

[简体中文](manual.md) · English

```
┌──────────────────────────────────────────────────┐
│ ● 5 个 agent 在跑 · 2 定时                  ▾  │ ← headline + collapse
├──────────────────────────────────────────────────┤
│ ▾ ● dsh                          2 个 workspace  │ ← top-level agent: this DSH instance
│ ├─ ▾ proj-alpha                              2  │ ← workspace
│ │  ├─ ▾ ● Refactor billing flow  ⏱8m  v4.1-pro  │ ← conversation (green)
│ │  │  ├─ ● Explore repo structure      1m5s     │ ← subagent (blue)
│ │  │  │  └─ ● Run unit tests              9s     │ ← grandchild (violet)
│ │  │  └─ ● Write migration plan          31s     │
│ │  └─   Fix flaky login test      ⏱2h  v4.1-flash │ ← scheduled, currently idle
│ ├─ ▾ my-repo                                 1  │
│ │  └─ ● Triage CI failures        v4.1-pro       │
│ ▾ ● claude  proj-alpha                 12m 3%    │ ← top-level agent: local claude (dsh peer)
│ │  └─ computer use ×2                    41m     │ ← its children, grouped by kind
│ ▾ ● codex   ChatGPT                 69h35m 2%    │
│    ├─ MCP ×2                             2h50m   │
│    ├─ computer use ×2                     41m    │
│    └─ code mode                           41m    │
│ 会话 6 · 子代理 3 · 运行中 5（live）             │ ← self-check line
└──────────────────────────────────────────────────┘
```

## 1. Headline

| Text | Meaning |
|---|---|
| `● 5 个 agent 在跑 · 2 定时` | 5 sessions/subagents are running; 2 sessions have an active schedule |
| `空闲 · 2 个定时待命` | nothing running, only scheduled tasks pending |
| `🌳 Agent Tree Dock 1 待处理 🤖5 ⏰3 ⌃` | collapsed: a round capsule with three counters — waiting / running agents / scheduled tasks; zero counters are hidden |
| the “—” button in the header / the capsule itself | manual collapse / expand; manual wins over auto-collapse |
| the paint-drop button in the header | open the skin list and switch skins (see 1.6) |
| the spinner button in the header | check for a plugin update — only goes online on click (see 1.7) |

Auto-collapse rule: collapse when `running === 0 && scheduled === 0`; expand automatically as soon as work appears
(unless you collapsed it manually).

## 1.4 Sessions waiting for your call

When an agent asks a question (`ask_user_question`), waits for an approval, or waits for a plan review, the session
stops at "waiting for input" and no longer counts as running. The card puts those rows **first**, in amber, with a badge:

```
├─ ● Research team 1         待答   v4.1-pro
│  └─ ● Plan review          待审
```

- `待答` — the agent asked a question and waits for your answer.
- `待批` — waiting for you to approve one operation.
- `待审` — waiting for your plan review.

They sort above running rows, so they can never be collapsed away for "not running"; the headline becomes
`N waiting for you · M running · K scheduled`.

## 1.5 Levels

Four levels (plus grandchild, i.e. five in the deepest row):

```
dsh (this instance)
└─ workspace
   └─ conversation
      └─ subagent
         └─ grandchild …
```

The `dsh` root row collapses every workspace at once; its right side shows the workspace count.

## 1.6 Skins

Left of the “—” in the header there is a paint-drop button. It opens the built-in skins:

| Skin | Palette | Details |
|---|---|---|
| Default | follows the DSH theme | plain white / dark card, no decoration |
| Sakura | pink + rose | pink banner, redrawn sakura icon, rose border / shadow, level-2/3 dots turn pink / violet; a whole sakura branch grows outside the card |
| Whale girl | DeepSeek blue + sea gradient | blue banner, redrawn whale icon, blue-tinted text and counters; a baby whale peeks out of the top-right corner |

- Picking one applies immediately; the choice lives in `localStorage: dsh-agent-tree:skin`;
- Sakura / Whale girl ship **frame decorations**: transparent assets rendered outside and behind the card, so only the part sticking
  out is visible — like it grows out of the dock. When collapsed, the first decoration sticks to the capsule's top-right corner;
- The collapsed capsule keeps the skin too (the paint drop lives in the expanded header);
- `Esc` or clicking the paint drop again closes the list;
- Every skin carries its own dark values and follows DSH's `body[data-ds-dark-theme]`.

To add your own (or tweak a few colours) without touching the code, register `--dat-*` CSS variables plus an optional
`decor` list on `window.__DSH_AGENT_TREE_SKINS__` — the full variable table, icon / banner / decoration recipes and an
example are in the [skin guide](skins.en.md).

## 1.7 Update check

The middle ghost button in the header is the **spinner**:

| State | What you see |
|---|---|
| idle | a faint circular arrow; a small dot sits on the button when a newer version is known |
| clicked | the icon spins and a small panel opens under the header |
| up to date | `✓ 已是最新 · v0.1.3` plus “checked npm registry just now / N minutes ago” |
| update found | `↑ 发现新版本 vX` with a one-click copy of the upgrade command |
| failure | a red hint (“browser can't reach the npm registry”) and a retry |

- **Online only on click**: one read-only GET to `https://registry.npmjs.org/dsh-plugin-agent-tree/latest`, no cookies, no
  token, no polling, nothing about your machine is sent;
- The result (latest version + timestamp) is cached in `localStorage: dsh-agent-tree:update` for 30 minutes, so the dot
  survives a reload;
- The command is `dsh plugin --profile web add dsh-plugin-agent-tree@latest`;
- `PLUGIN_VERSION` in `client.js` must equal `version` in `package.json` (`npm run verify` enforces this) — bump both when releasing.

## 2. Row elements

| Element | Meaning |
|---|---|
| `├─ └─ │` | git-log-style connectors; each depth adds three columns of indentation |
| `▾ / ▸` | this row has children — expand / collapsed |
| `●` | status dot, colored by depth (below) |
| Title | session title (`displayTitle`), elided when long; running rows are bolder |
| `⏰` + `8m` | countdown to the next scheduled run: `now` / `<1m` / `8m` / `2h` / `3d` |
| `v4.1-flash` | model chip (right aligned) from `modelSelection`, with `deepseek-` / `anthropic-` prefixes stripped |
| `1m5s` | elapsed duration (subagent rows only): `45s` / `12m` / `1h5m` |

## 3. Colors

| Color | Meaning |
|---|---|
| green | top-level conversation running in its own session |
| blue | level-2 subagent |
| violet | level 3 and deeper |
| grey / dim | finished, kept only to preserve the hierarchy |
| orange / green (bottom block) | claude process / codex process |

## 4. Model inheritance

Subagent projections often carry no `modelSelection`; the card then uses the nearest ancestor's model and the tooltip
says it was inherited. So every row can answer "which model is this".

## 5. Scheduled rows

DSH Automation tasks (`schedule.catalog()`) drive intermittent sessions: idle most of the time, they fire on a timer.
Those sessions are listed even while idle, with `⏱` showing the next fire time — clicking jumps to them as usual.

## 6. Other local dsh instances

One `~/.dsh` can serve several `dsh web --port 30xx` at once. The browser only sees the instance it is connected to,
but the process table and the session store are shared, so the host half can read the others:

- `ps` finds `dsh ... web` processes (excluding itself);
- `lsof -a -p <pid> -iTCP -sTCP:LISTEN` gives their listening ports (`3080` usually also has `3081`);
- `lsof -p <pid> -Fn` shows `~/.dsh/sessions/<project>/session-<id>/` — the sessions they currently have open.

```
▾ ● dsh :3083                2 sessions · 2 subagents
├─ ● 推进 backlog 任务并设循环     1m
└─ ▾ ● PMO                 2子   6m
   ├─ ● 巡检流水线               4m
   └─ ● 汇总日报                 7m
```

- **Only sessions still working are listed**: with a live status it trusts that (running / waiting for you), otherwise it
  treats a session as active when it changed within the last 5 minutes; stale sessions are hidden and an instance with nothing
  active is dropped entirely.
- Titles come from the shared session store, so they match what that instance shows; the right side is "last touched".
- `N子` is how many subagents hang off that session (counted via `parentId` in the session table); `▸` expands up to 6 child rows.
- Click the instance row / a session row to open that port in a new tab (no deep link to the exact session).
- Session ids missing from this instance's store (e.g. another `DSH_HOME`) are only counted in the tooltip.
- At most 4 instances, 6 rows each.

## 7. Local external agents (peers of dsh)

Read-only probe from the host half, listing running `claude` / `codex` CLIs on this machine. They are
**top-level nodes just like `dsh`** (same row spec: same font size, same dot, same collapse); only the dot
color differs (claude orange / codex green):

```
├─ ● claude  proj-alpha        12m 3%
└─ ● codex   my-repo            3m
```

- `label` resolution: real cwd basename → `--cwd/--cd/-C` from the command line → `ChatGPT` for the desktop backend → empty.
- Max 8 rows, 3s cache on the host, requires a logged-in session (401 otherwise).
- Purpose: "while I work inside DSH, is some other agent also running on this machine?"

### 6.1 Children of an external agent

`claude` / `codex` children hang under them by `ppid`, grouped by kind:

```
├─ ▾ ● codex  ChatGPT        69h35m 2%
│  ├─ MCP ×2                    2h50m
│  ├─ computer use ×2             41m
│  └─ code mode                   41m
```

- `×N` = how many children of that kind; the right column shows the longest elapsed among them.
- Clicking the process root collapses its subtree.
- A real agent CLI found among the descendants is listed as its own root instead of being nested twice.

### 6.2 codex sub-conversations (subagent threads)

Every codex session (CLI or ChatGPT desktop) writes a rollout: `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`.
Its first line is `session_meta`, which already carries `thread_source: subagent`, `parent_thread_id`,
`agent_nickname` and `agent_path`. The plugin reads only those headers and rebuilds the tree by `parent_thread_id`,
hanging it under the codex row:

```
▾ ● codex ChatGPT              69h35m 2%
   ├─ ● Hubble   advance_review_logic       running
   ├─ ● Carson   review_nextarchive_code    16m前
   ├─ ● Wegener  review_nextarchive_triage  1h42m前
   ├─ MCP ×2                                2h50m
   └─ computer use ×2                        41m
```

- Active within the last two minutes → `running` (green, bold); otherwise "last active N ago".
- Which main session: matched by the process cwd first (worktree runs match on a cwd prefix); for ChatGPT desktop
  processes the cwd is usually `/`, so a session whose `originator` contains `Desktop` wins.
- At most 8 sub-conversations, 3 levels deep. Local read-only, no network.

### 6.3 The codex row's name

The row is named after **the first real request of that codex session** (skipping codex's own
`environment_context` / `AGENTS.md instructions` injections), followed by a grey directory chip:

```
▾ ● codex 推进一下能推进的任务，看看流水线…   devline   69h35m 2%
```

- Falls back to the directory name / `ChatGPT` only when the rollout has no user message yet.
- With several codex processes in one cwd, each claims a distinct session by recency, so rows never share a name.

## 8. Interaction

| Action | Effect |
|---|---|
| click a row | jump to that session (subagents open their own conversation) |
| click `▾/▸` | collapse / expand that node's children |
| drag the header | move the card; position saved in `localStorage: dsh-agent-tree:pos` |
| click the “—” in the header / the capsule | collapse to a capsule / expand the whole card |
| click the paint-drop button in the header | open the skin list and pick a skin |

## 9. Refresh cadence

| Data | Cadence |
|---|---|
| running state | official `api-session/status` events (`live`); 1s snapshot polling (`poll`) as fallback |
| scheduled tasks | `schedule/changed` events + a 15s poll |
| external processes | every 5s (host caches for 3s) |
| countdown / duration | recomputed every second |

## 10. Self-check line

`会话 N · 子代理 M · 运行中 K（live|poll）`

- `N` sessions in the snapshot, `M` of them `origin: subagent`, `K` considered running;
- `live` = official realtime events, `poll` = fallback. If it stays `poll`, this DSH build lacks the global status
  store — worth an issue.

## 11. Known limits

- Only the current Web instance's sessions are visible (not other profiles or machines).
- Running state follows DSH status events; a finished subagent may linger for a second or two.
- Width is fixed at 288px; long titles elide (change `WIDTH` in `client.js`).
- UI strings are Chinese for now.
