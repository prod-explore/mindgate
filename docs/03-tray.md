# Tray app — mindgate-tray

A small app in the system tray of the compute machine. It shows what the agent is doing, lets you say "I'm using this PC, don't shut it down", and keeps Windows from shutting down while the agent is busy.

Built with Node.js and the `systray2` library. It is written for Windows (the idle check and the shutdown block use Windows APIs). Linux is supported on a best-effort basis: the icon and the idle check (`xprintidle`) are there, the shutdown block is not (shutdown there is controlled by systemd/polkit).

---

## Requirements

- Node.js 22+
- Windows 10+ — or Linux with a desktop environment (GNOME, KDE, XFCE) and `xprintidle`
- On Linux: `libappindicator` (most desktop environments have it)
- On Windows, the .NET Framework compiler (`csc.exe`, part of Windows) — the tray compiles two tiny helper programs the first time it needs them: one reads the idle time, one holds the shutdown back

---

## Installation

```bash
cd mindgate/tray
npm install
cp config/tray.example.yml config/tray.yml
# set agent.secret to the MINDGATE_NODE_SECRET from agent/.env, and hub.url to the address of your hub
npm start
```

### Autostart — Windows

```bash
npm run install-autostart
```

The script generates `start-tray.vbs` with absolute paths for this machine and adds an entry to `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. To remove it: `reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v MindGateTray /f`.

### Autostart — Linux

Create `~/.config/autostart/mindgate-tray.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=MindGate Tray
Exec=/usr/bin/node /home/your-user/mindgate/tray/src/index.js
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
```

---

## What it shows

### The icon

The icon changes colour with the state of the agent, which the tray polls every 5 seconds (`GET /health`):

| Colour | State |
|--------|-------|
| Green | The agent is ready and idle |
| Yellow | The agent is working: a request is in flight or a model is being downloaded |
| Red | The agent rejected the secret, returned an error, or reports problems |
| Grey | The agent does not answer, or the tray has not heard from it yet |

The first line of the menu says the same in words ("MindGate — ready"), and the second one lists the models that are loaded into memory.

### The menu (right click)

```
MindGate — ready
In memory: qwen3:4b
─────────────────────────────
[x] Don't shut down this computer
    Open the MindGate panel          (only when hub.url is set)
─────────────────────────────
    Quit MindGate (agent and tray)
```

- **Don't shut down this computer** — the toggle described below.
- **Open the MindGate panel** opens `<hub.url>/admin/` in the browser.
- **Quit MindGate (agent and tray)** tells the agent to exit (`POST /node/exit`) and closes the tray.

### The toggle

While it is on, the machine is **never** shut down, however long it has been idle. It switches on **by itself** when the tray sees mouse or keyboard input (input within the last `idle_threshold_seconds`), and it stays on until you switch it off in the menu. Switch it on by hand when you are going to leave something running that produces no input — a long installation, music, a download.

The toggle is not remembered: after the tray restarts it starts off, and turns on again as soon as it sees you at the keyboard.

---

## The shutdown guard

A shutdown starts in the hub: after `idle_shutdown_minutes` without requests it asks the agent (`POST /node/power/shutdown-request`). The agent checks its own side and then asks the tray (`POST /shutdown-check`):

```
Agent (itself):
  1. Is a /v1 request or a model download in progress?  → NO (requests_in_flight / download_in_progress)
Tray (when the agent asks):
  2. Is the "don't shut down" toggle on?                → NO (user_toggle_active)
  3. Has input happened in the last N seconds?          → NO (user_recently_active)
```

The tray's verdict is final. If the tray does not answer (not running, hung), the agent refuses (`tray_unreachable`): a computer someone may be sitting at is not shut down on a guess. On a server without a tray (`MINDGATE_TRAY_URL=` empty in `agent/.env`) the agent decides alone. Only when every condition is met does the agent run `shutdown`, with a delay (`MINDGATE_SHUTDOWN_DELAY_SECONDS`, 30 s by default).

While the agent is busy (a request in flight or a download), the tray also blocks a manual shutdown from the Windows Start menu — Windows shows that MindGate is processing AI requests.

### Checking for user activity

- **Windows** — `GetLastInputInfo`, through `ffi-napi` when it installed, otherwise through a small C# program (`get-idle-time.exe`) compiled from `src/get-idle-time.cs` the first time it is needed.
- **Linux** — `xprintidle`.

If the idle time cannot be read, the tray assumes the user is active (0 seconds idle), which holds the shutdown back.

Configuration (`tray/config/tray.yml`):

```yaml
shutdown_guard:
  idle_threshold_seconds: 120     # 2 minutes without input = "idle"
```

---

## IPC with the agent

The tray and the agent talk over HTTP on localhost. The agent's paths need `Authorization: Bearer <MINDGATE_NODE_SECRET>`; the tray takes the same secret from `agent.secret` in `tray.yml` (or from the environment variable `MINDGATE_NODE_SECRET`).

```
Agent  →  POST http://127.0.0.1:3002/shutdown-check  →  Tray   { idle_minutes }  →  { allow, reason }
Tray   →  GET  <agent>/health                         (every 5 s: state, icon, `in_flight` + `downloads` = "busy")
Tray   →  POST <agent>/node/user-active               (every 5 s and when the toggle changes: { active, last_input_seconds_ago })
Tray   →  POST <agent>/node/exit                      (menu "Quit MindGate": the agent exits)
```

The tray's small server (port 3002, `127.0.0.1` only) also serves `GET /status` (`user_toggle_active`, `idle_seconds`). It has no authentication: it only listens on the loopback interface, and what it reveals or changes is limited to this one machine's own state.

The agent's full contract: [05 - Node protocol](05-nodes.md). A test in the repository (`e2e/`) checks that every path the tray calls exists in the agent.

---

## Code layout

```
tray/src/
├── index.js           main loop, systray setup, polling the agent
├── state.js           turns the agent's state into an icon and text (pure, tested)
├── menu.js            builds and updates the tray menu
├── ipc.js             the local HTTP server and the reports to the agent
├── idle.js            idle time (Windows API / C# fallback / xprintidle)
├── shutdown-block.js  holds a manual Windows shutdown back while the agent is busy
├── blocker.cs         the helper program for it
├── get-idle-time.cs   the idle-time helper
├── config.js          loads tray.yml
└── icons/             green, yellow, blue, red, gray (.ico)
```

---

## Troubleshooting

**The icon does not appear (Linux)**
Install `libappindicator3-1`:
```bash
sudo apt install libappindicator3-1
```
On GNOME the "AppIndicator and KStatusNotifierItem Support" extension may be needed.

**The idle time is always 0 (Windows)**
Look at the tray's log for "Idle detection". If the native API is unavailable it falls back to the C# helper, which needs `csc.exe` from the .NET Framework (`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\`). If the compiler is missing, the idle time cannot be read and the tray treats you as always active.

**The tray says "agent rejected the secret"**
The `agent.secret` in `tray.yml` differs from `MINDGATE_NODE_SECRET` in `agent/.env`.

**The icon is yellow although nobody is using the hub**
Yellow means the agent counts a request in flight or a download. Look at `in_flight` and `downloads` in `GET <agent>/health` and at the hub's request log to see which client is sending requests (a model-list request, `GET /v1/models`, is not counted as work).
