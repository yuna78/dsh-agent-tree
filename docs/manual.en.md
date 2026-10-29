# Manual: how to read the card

[简体中文](manual.md) · English

```
┌──────────────────────────────────────────────────┐
│ ● 5 个 agent 在跑 · 2 个定时                  ▾  │ ← headline + collapse
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
| `● 5 个 agent 在跑 · 2 个定时` | 5 sessions/subagents are running; 2 sessions have an active schedule |
| `空闲 · 2 个定时待命` | nothing running, only scheduled tasks pending |
| `● Agent 树 ▸` | collapsed (single line) |
| `▾ / ▸` on the right | manual expand / collapse; manual wins over auto-collapse |

Auto-collapse rule: collapse when `running === 0 && scheduled === 0`; expand automatically as soon as work appears
(unless you collapsed it manually).

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

## 2. Row elements

| Element | Meaning |
|---|---|
| `├─ └─ │` | git-log-style connectors; each depth adds three columns of indentation |
| `▾ / ▸` | this row has children — expand / collapsed |
| `●` | status dot, colored by depth (below) |
| Title | session title (`displayTitle`), elided when long; running rows are bolder |
| `⏱8m` | countdown to the next scheduled run: `now` / `<1m` / `8m` / `2h` / `3d` |
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

## 6. Local external agents (peers of dsh)

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

## 7. Interaction

| Action | Effect |
|---|---|
| click a row | jump to that session (subagents open their own conversation) |
| click `▾/▸` | collapse / expand that node's children |
| drag the header | move the card; position saved in `localStorage: dsh-agent-tree:pos` |
| click headline `▾/▸` | collapse / expand the whole card |

## 8. Refresh cadence

| Data | Cadence |
|---|---|
| running state | official `api-session/status` events (`live`); 1s snapshot polling (`poll`) as fallback |
| scheduled tasks | `schedule/changed` events + a 15s poll |
| external processes | every 5s (host caches for 3s) |
| countdown / duration | recomputed every second |

## 9. Self-check line

`会话 N · 子代理 M · 运行中 K（live|poll）`

- `N` sessions in the snapshot, `M` of them `origin: subagent`, `K` considered running;
- `live` = official realtime events, `poll` = fallback. If it stays `poll`, this DSH build lacks the global status
  store — worth an issue.

## 10. Known limits

- Only the current Web instance's sessions are visible (not other profiles or machines).
- Running state follows DSH status events; a finished subagent may linger for a second or two.
- Width is fixed at 288px; long titles elide (change `WIDTH` in `client.js`).
- UI strings are Chinese for now.
