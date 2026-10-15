# Agent — the node with the models

A small service on the computer with the GPU. The hub (see [01 - Hub](01-gate.md)) talks to it instead of talking to Ollama directly, and so **everything about the models on that machine is controlled from the hub**: what is installed, downloading a new model, deleting one, loading it into memory, shutting the computer down.

The agent does four things:

1. **Looks after Ollama.** If Ollama is already running, it takes it over; if not, it starts it itself (and stops it together with itself). If Ollama dies, the next request starts it again.
2. **Passes `/v1/*` through to Ollama** (the OpenAI-compatible API) — behind a secret, rewriting nothing. The one exception is `GET /v1/models`, because the agent knows more about a model than Ollama says outright (what the model can do, its real context length, tags).
3. **Gives the hub a management API** (`/node/*`): machine status, model list, background downloads, deletion, loading into and unloading from memory. Full description: [05 - Node protocol](05-nodes.md).
4. **Shuts the computer down** at the hub's request after a period of inactivity — but only when nothing is in progress and nobody is using the PC (see [03 - Tray](03-tray.md)).

What the agent does **not** do: there are no profiles (`flash`, `reasoning`…), no pipelines, no MCP tools and no queue of its own. The names for clients are **aliases in the hub**, the hub runs the queue (the provider's `max_concurrency`), and you pick a model simply by its Ollama name. That keeps the agent so simple that there is hardly anything in it that can break.

---

## Requirements

- Windows 10/11 or Linux (Ubuntu 22.04+ / Debian 12+)
- Node.js 22+
- [Ollama](https://ollama.com) installed (the agent can start it, but does not install it)
- A GPU with CUDA (optional, but without one larger models will be slow); `nvidia-smi` on the PATH lets the hub show the card's memory use

---

## Installation

```bash
cd mindgate/agent
npm install
npm run build

cp .env.example .env
# generate a secret and put it into MINDGATE_NODE_SECRET:
openssl rand -hex 32
```

The same secret then goes to three places: `agent/.env` (`MINDGATE_NODE_SECRET`), the hub (as the provider's "API key") and `tray/config/tray.yml` (`agent.secret`). The agent **will not start** with the placeholder from `.env.example` or with a secret shorter than 24 characters.

A trial run:

```bash
npm start
```

A check (replace `SECRET` and the address):

```bash
curl -H "Authorization: Bearer SECRET" http://192.168.1.100:3001/health
# {"status":"ok","node_id":"MY-PC","runtime":"ok","in_flight":0,"downloads":0,"models_loaded":[],"uptime":12,...}

curl -H "Authorization: Bearer SECRET" http://192.168.1.100:3001/node/status
```

---

## Configuration (`agent/.env`)

The agent loads `agent/.env` by itself — regardless of where it was started from (a Windows service does not start in its folder). Environment variables take precedence over the file.

| Variable | Default | Meaning |
|---|---|---|
| `MINDGATE_NODE_SECRET` | — (required) | the shared secret: `Authorization: Bearer …` |
| `MINDGATE_NODE_ID` | the computer's name | how the machine is named in the panel and in `/node/status` |
| `MINDGATE_NODE_HOST` / `MINDGATE_NODE_PORT` | `0.0.0.0` / `3001` | where the agent listens |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | the address of Ollama |
| `MINDGATE_MANAGE_OLLAMA` | `true` for a local address | whether the agent may start Ollama when it is not running |
| `OLLAMA_PATH` | found automatically | the full path to `ollama` / `ollama.exe`, when the search does not find it |
| `MINDGATE_OLLAMA_START_TIMEOUT_MS` | `30000` | how long to wait until a started Ollama begins to answer |
| `MINDGATE_TRAY_URL` | `http://127.0.0.1:3002` | the tray on this machine; **empty = no tray** (a server without a screen) |
| `MINDGATE_SHUTDOWN_DELAY_SECONDS` | `30` | the delay of the system `shutdown` (Linux rounds it up to whole minutes) |
| `LOG_LEVEL` | `info` | |

An Ollama started by the agent inherits its environment (without the `MINDGATE_*` variables), so you can keep its settings in the same `.env`. For a 4 GB card these make sense:

```
OLLAMA_CONTEXT_LENGTH=8192      # a larger context = more memory for the cache; a model often allows 32k+ on its own
OLLAMA_MAX_LOADED_MODELS=1      # one model at a time, the rest wait for memory to be freed
OLLAMA_NUM_PARALLEL=1
OLLAMA_KEEP_ALIVE=5m            # after 5 minutes without use the model leaves the card
OLLAMA_MODELS=D:\ollama-models  # where the model files live (when the system disk is small)
```

When the agent knows `OLLAMA_CONTEXT_LENGTH`, it **reports exactly that** to the hub as the model's context length (not what the model can do in theory). That way the hub does not promise clients a window that Ollama would not use anyway.

### Ollama started separately

If Ollama already runs as a system service (typically on Linux after the script installation), the agent simply takes it over and never stops it. If Ollama is on **another computer**, set `OLLAMA_URL` to its address — then the agent starts nothing (`MINDGATE_MANAGE_OLLAMA` is off) and works as a gateway with a secret. Remember that Ollama itself has no authentication: do not expose it outside the machine, the agent is there to put it behind a secret.

---

## Running as a service

### Windows

In PowerShell **as administrator**:

```powershell
cd mindgate\agent
npm run install-service
```

This creates the "MindGate Agent" service (automatic start). To remove it: `npm run uninstall-service`. After a code update (`git pull`) it is enough to `npm install`, `npm run build` and restart the service — `Restart-MindGate-Simple.bat` in the repository root does that.

Windows Defender Firewall has to let port `3001` through from the local network (only from the hub's address, if you can).

### Linux (systemd)

```bash
sudo cp mindgate-agent.service /etc/systemd/system/
sudo nano /etc/systemd/system/mindgate-agent.service    # User= and WorkingDirectory=
sudo systemctl daemon-reload
sudo systemctl enable --now mindgate-agent
journalctl -u mindgate-agent -f
```

So that the agent can shut the computer down without a password, give it a single sudo rule (`sudo visudo -f /etc/sudoers.d/mindgate`):

```
your-user ALL=(root) NOPASSWD: /usr/sbin/shutdown
```

(If the agent runs as `root`, nothing is needed — it calls `shutdown` without `sudo` anyway.)

---

## Adding the machine to the hub

The easiest way is the panel / API: the preset **"A PC with a GPU (MindGate agent)"** (`GET /admin/api/presets`). By hand:

```bash
curl -X POST http://localhost:3000/admin/api/providers \
  -H "Authorization: Bearer $MINDGATE_ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
  "id": "pc",
  "name": "My PC",
  "type": "openai",
  "base_url": "http://192.168.1.100:3001/v1",
  "api_key": "<MINDGATE_NODE_SECRET>",
  "locality": "local",
  "max_concurrency": 1,
  "options": { "first_byte_timeout_ms": 600000, "idle_timeout_ms": 300000 },
  "node": {
    "mac": "AA:BB:CC:DD:EE:FF",
    "broadcast": "192.168.1.255",
    "control_url": "http://192.168.1.100:3001",
    "idle_shutdown_minutes": 15
  }
}'
```

`control_url` is the one thing that tells the hub "the agent is here": from it the hub derives the address for checking the state (`/health`) and for the shutdown request (`/node/power/shutdown-request`). Without it the node still works (waking, requests), but its models cannot be managed from the hub. Waking: [06 - Wake-on-LAN](06-wol.md).

From there everything happens in the hub — downloading a model (`POST /admin/api/providers/pc/node/pulls {"name":"qwen3:4b"}`), the list, deletion, aliases: [04 - Models](04-models.md) and [08 - API](08-api.md).

---

## Shutting the computer down

The hub asks for a shutdown after `idle_shutdown_minutes` without requests. The agent answers `{"allow": …, "reason": …}` and shuts the computer down only when **all** the conditions are met:

1. no request is in progress (`requests_in_flight`),
2. nothing is being downloaded (`download_in_progress`),
3. the tray confirms that nobody is using the PC (see [03 - Tray](03-tray.md)) — its "no" is final; when the tray **does not answer**, the reply is `tray_unreachable`, because a computer someone may be sitting at is not shut down on a guess.

Without a tray (`MINDGATE_TRAY_URL=` empty, a server without a screen) only conditions 1 and 2 count.

After a "no" the hub waits 5 minutes before asking again. A person can shut the machine down from the hub directly (`POST …/node/shutdown` with `"force": true`) — that is their decision, so it skips conditions 1–3.

---

## Security

- Every call to the agent (`/health` too) needs the secret; the comparison is timing-safe, and a request without the secret never reaches Ollama.
- The secret is not passed on to Ollama or to its child process.
- The agent listens on `0.0.0.0`, because the hub is on another computer. If only the LAN can see the machine, that is enough; otherwise restrict port 3001 with a firewall to the hub's address, or set `MINDGATE_NODE_HOST` to one interface.
- The traffic between the hub and the agent is plain HTTP. For a home network that is usually acceptable; beyond it, put WireGuard / Tailscale underneath.
- Access to `/node/*` means being able to download any model to the disk and to shut the computer down. That is why there is a single secret, and only for the hub (and the tray).

---

## Troubleshooting

**The agent exits at once with "MINDGATE_NODE_SECRET is not set / too weak"** — the secret in `agent/.env` is missing or is a placeholder. `openssl rand -hex 32`.

**The hub shows `node_auth_failed`** — the secret in the hub (the provider's "API key" field) differs from `MINDGATE_NODE_SECRET`.

**The hub shows `agent_missing`** — no MindGate agent answers at `control_url` (a wrong port, a wrong prefix, another service). `curl -H "Authorization: Bearer …" <control_url>/node/status` shows what is there.

**`runtime_unavailable` / "Ollama is not installed here"** — the agent did not find `ollama`. Install it or set `OLLAMA_PATH`.

**The first request after a start takes a minute** — the model is loading from the disk into the card. That is why a provider from the preset has `first_byte_timeout_ms` of 10 minutes. You can load it in advance (`…/node/models/load`).

**The model does not fit on the card** — Ollama moves part of the layers to RAM and runs slower; it does not stop working. See [04 - Models](04-models.md) on choosing a size.
