# Desktop dock: the card, outside the DSH window

> macOS only (AppKit + WebKit). Windows/Linux equivalents can come later if wanted.

The Agent Tree card normally lives inside the DSH window — and a web page cannot paint
outside the browser viewport, so it disappears the moment you switch apps. The **desktop
dock** hands the very same card to a tiny separate process: a transparent, borderless,
always-on-top window that follows all Spaces, visible no matter which app is frontmost.

The docked card and the in-page card are the **same React component and skins**
(`client.js`'s `MiniInner`), so looks, interactions, pill collapse and the update panel are
identical. The difference is only the data path — one extra hop:

```
DSH page (browser)                         Dock shell (desktop/ artifacts)
┌────────────────────────────┐             ┌─────────────────────────────────┐
│ client.js publisher: POST   │ ──────────▶ │ GET /local/dsh-agent-tree/dock/  │
│ a pruned render snapshot 1/s│             │ state (with handshake token)     │
│                            │             │        │ inject into dock.html    │
│ openSession ◀──────────────┼─────────────┤ MiniInner render (page = no net)  │
│        ▲ queued action      │ ◀────────── │ row click → POST /dock/action    │
└────────────────────────────┘             └─────────────────────────────────┘
```

## Install & run

The plugin installs via npm as usual; the shell is a locally compiled binary with zero
third-party dependencies (one `swiftc` command):

```bash
npm run dock:build                       # = bash desktop/build.sh
./desktop/build/dsh-agent-tree-dock      # or one step: npm run dock
```

Prerequisites:

1. A dsh instance with dsh-plugin-agent-tree installed is running;
2. Its web page is open in a browser — the snapshot is published **by the browser side**;
   until then the dock shows “waiting for the DSH page…”, and data appears within a second
   of the page opening.

On launch the shell reads `$DSH_HOME` (default `~/.dsh`) for `agent-tree-dock-<port>.json`
(a handshake file written by the host plugin once the web server is listening; mode 0600,
containing only origin / port / token). With several dsh instances it picks the newest one,
or point it explicitly:

```bash
./desktop/build/dsh-agent-tree-dock --origin=http://127.0.0.1:51638
./desktop/build/dsh-agent-tree-dock --port=51638 --token=<token from the handshake file>
./desktop/build/dsh-agent-tree-dock --verbose    # poll / layout / action logs → stderr
./desktop/build/dsh-agent-tree-dock --reset      # forget the remembered window position
```

## Interaction

| Action | Behavior |
| --- | --- |
| Drag the card header / pill | Moves the whole dock window (position kept in UserDefaults) |
| Click a row | action queued at the host → browser side runs `openSession`; DSH is brought frontmost |
| Right-click the card | Open DSH / Reset position / Quit dock |
| Click anywhere else | Falls through to the desktop (only card, pill and menu rects are clickable) |
| Click the pill | Collapse / expand; the dock height follows the card (top edge stays put) |
| Links in the update panel | Handed to the system browser |

## Privacy & security

- The page is a local `file://` bundle with **zero network**: every byte is polled by the
  shell and injected; React ships locally in `desktop/vendor/`;
- Every shell request carries the handshake token; the file is 0600, readable only by you.
  DSH restarts rotate the token; the old shell gets a 401 and re-reads the newest file;
- The host keeps exactly **one latest snapshot in memory** — nothing on disk, nothing off
  the machine; it disappears with the host process;
- Snapshots are pruned (`dockPayload` in client.js): no conversation content; the projection
  keeps only model selection / subagent timing / pending-interaction kind.

## Boundaries & known trade-offs

- **Near-real-time**: the publisher ticks once a second (8s when idle), so the dock lags the
  in-page card by about a second;
- **Skins don't sync**: the WKWebView uses a non-persistent data store, so the dock's skin
  choice resets on relaunch; pick the same skin again inside the dock;
- **One shell per instance**: the shell polls one origin from the handshake files; run one
  shell per instance (`--origin=` each);
- If the browser page closes, the dock dims to an offline state within 30 seconds and
  recovers automatically when the page returns.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| “waiting for the DSH page…” never clears | ① is dsh running: `ls ~/.dsh/agent-tree-dock-*.json`; ② is the page open in a browser for that instance; ③ `--verbose`: 200 vs 401 / connection refused |
| 401 | DSH restarted and rotated the token: the shell should self-heal; if it stays 401, restart the shell |
| Card not clickable / draggable | `--verbose` shows `pass rects`; zero means the page hasn't reported layout yet — wait a second or `--reset` |
| Window height doesn't match the card | Collapse/expand once to re-measure; still off, capture `layout` logs with `--verbose` |
| **Dock content doesn't match the card inside DSH** | The dock mirrors whatever single instance's page publishes the snapshot (discovery prefers the live one; `--origin=` to pin). Until the desktop app is upgraded to 0.1.6 and restarted, the app's own page cannot publish, so the dock attaches to another instance — whose tree cannot see sessions **running inside the app** (it does not receive that instance's event stream). Data boundary, not a bug; after the app upgrade the two are 1:1. |
| Row click does nothing | The session opens in the page that publishes the snapshot: if that is some browser tab, the jump happens there; `--verbose` shows `open → 200` when the action was delivered |

Build and development details: [`desktop/README.md`](../desktop/README.md).
