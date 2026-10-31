# Install & configuration

[简体中文](install.md) · English

`dsh-plugin-agent-tree` is a DSH Web client plugin with a tiny host half. It is not a standalone app: it runs on a
DSH profile and shows up as a small floating card in a corner of the DSH Web UI.

## 0. Prerequisites

| Dependency | Version | Notes |
|---|---|---|
| Node.js | `^22.19` or `≥ 24` | same as the DSH runtime |
| pnpm | 10+ | DSH manages profile dependencies with pnpm |
| DSH | `≥ 0.2.1-rc.2 < 0.3.0` | verified on `0.2.1-rc.2`, npm-distributed build |
| An LLM provider | — | the plugin needs no key itself, but you need sessions to observe |

```sh
npm i -g @deepseek-ai/dsh@0.2.1-rc.2
dsh --version
```

## 1. Fresh profile (recommended)

```sh
dsh --profile agent-tree --from-default-profile web
dsh plugin --profile agent-tree add dsh-plugin-agent-tree
dsh --profile agent-tree --port 13090
```

Open the URL printed in the terminal (the one with the token) — the card is in the bottom-right corner.

## 2. Existing profile

```sh
dsh plugin --profile web add dsh-plugin-agent-tree
# then restart the command you normally use to start dsh web
```

## 3. Other install paths

```sh
dsh plugin --profile web add "github:yuna78/dsh-agent-tree"
dsh plugin --profile web add "$PWD"        # local development
```

## 4. One mandatory step: restart

The plugin ships a **host half** (it registers `GET /local/dsh-agent-tree/processes` for the process probe), so the
`dsh` process must be restarted once after installing; then hard-refresh the browser (`Cmd/Ctrl + Shift + R`).

Client-only changes (`client.js`) need just a page refresh — the bundle `rev` is computed per request.

## 5. Verify

1. Open DSH Web: a capsule or the expanded tree card shows up in the corner.
2. Start a conversation and let it work: the headline becomes `● 1 个 agent 在跑`.
3. Run `claude --help` (or `codex --help`) in a terminal and leave it hanging: a `● claude …` row appears at the
   bottom of the card within a few seconds — that proves the host endpoint works.

## 6. Upgrade

```sh
dsh plugin --profile web add dsh-plugin-agent-tree@latest
# restart dsh, hard-refresh the browser
```

Or skip the command: expand the card and click the **spinner** button in the header — it checks npm once and, when a
new release exists, shows the command above with a one-click copy. The check only goes online on click (read-only GET, no cookies).

## 7. Uninstall

```sh
dsh plugin --profile web remove dsh-plugin-agent-tree
# restart dsh
```

A stale `dsh-agent-tree:pos` key stays in `localStorage`; remove it with
`localStorage.removeItem('dsh-agent-tree:pos')` if you care.

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| No card at all | dsh not restarted (host half) / page not hard-refreshed / package missing: `dsh plugin --profile web list` |
| Card off-screen | drag it back, or clear `dsh-agent-tree:pos` and refresh |
| Card says `空闲` (idle) | nothing is running and no active schedule — start a conversation |
| Subagent missing from the tree | that session is not running, or it belongs to another profile (the card only sees this Web instance) |
| No claude/codex block | host half not loaded (no restart) / not macOS or Linux / executable basename is not exactly `claude` or `codex` |
| "Add plugin" in DSH can't find it | the market index refreshes nightly; make sure the name is `dsh-plugin-agent-tree` |
| `[dsh-agent-tree]` warning in the startup log | host half warns and skips the endpoint when `webServer` is unavailable; the client keeps working |
