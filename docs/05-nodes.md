# Node protocol

This document describes what the hub does with a GPU machine and what it expects from it. The MindGate agent (`/agent`) is one implementation of this protocol; anyone who writes another one (a different engine than Ollama, a different system) can plug it into the hub with no changes on the hub's side.

A node is a provider with the `node` setting. The hub sees it on three levels:

| Level | What it needs | What it gives |
|---|---|---|
| **Provider** | an OpenAI-compatible server at `base_url` | requests, the model list (`GET /v1/models`) |
| **Machine** | `node.mac`, `node.broadcast` | Wake-on-LAN, detecting whether it sleeps |
| **Agent** | `node.control_url` + the protocol below | hardware status, downloading/deleting/loading models, shutting down |

Each further level is optional. A plain "provider" is, for example, a bare Ollama on the network.

## Authentication

Everything — `/health` too — needs `Authorization: Bearer <secret>`. The secret is the provider's "API key" in the hub. A missing or wrong secret gives `401`:

```json
{ "error": { "message": "Unauthorized: …", "type": "authentication_error", "code": "invalid_node_secret" } }
```

The hub turns this into `502 node_auth_failed` (it is the hub's configuration that is wrong, not the client's).

## Errors

Every agent error has the shape `{ "error": { "message", "type", "code" } }`. The codes the hub recognises:

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_node_secret` | 401 | wrong secret |
| `invalid_model_name` | 400 | a name outside `[A-Za-z0-9._\-:/@+]`, empty, or longer than 200 characters |
| `invalid_request` | 400 | a missing field, a wrong type |
| `model_not_found` | 404 | there is no such model on the machine |
| `pull_not_found` | 404 | there is no such download |
| `runtime_unavailable` | 503 | the model engine (Ollama) does not answer and cannot be started |
| `runtime_error` | 400/502 | the engine rejected the command; `message` carries its reason |
| `unknown_endpoint` | 404 | this is not (this) agent |

## State

### `GET /health`

A light state for the hub and the tray (the hub polls it every 30 s when the node has a `control_url`).

```json
{
  "status": "ok",              // "ok" | "degraded" (the engine does not answer)
  "node_id": "MY-PC",
  "version": "2.0.0",
  "runtime": "ok",             // "ok" | "unreachable"
  "in_flight": 0,              // /v1 requests in progress
  "downloads": 0,              // downloads in progress or queued
  "models_loaded": ["qwen3:4b"],
  "uptime": 3600
}
```

### `GET /node/status`

The full picture of the machine.

```json
{
  "node_id": "MY-PC", "version": "2.0.0", "platform": "win32", "hostname": "MY-PC", "uptime_seconds": 3600,
  "runtime": { "name": "ollama", "url": "http://127.0.0.1:11434", "ok": true, "version": "0.12.3", "managed": true, "error": null },
  "loaded": [ { "id": "qwen3:4b", "size_bytes": 3100000000, "vram_bytes": 2700000000, "expires_at": "…" } ],
  "in_flight": 0, "downloads": 0, "idle_seconds": 240,
  "user_active": false, "last_input_seconds_ago": 900, "user_active_updated_at": "…",
  "safe_to_shutdown": true, "shutting_down": false, "tray_configured": true,
  "system": {
    "cpu_count": 12,
    "memory": { "total_bytes": 17179869184, "free_bytes": 9000000000 },
    "gpus": [ { "name": "NVIDIA GeForce GTX 1650", "memory_total_bytes": 4294967296, "memory_used_bytes": 2900000000, "utilization_percent": 3 } ],
    "disk": { "path": "C:\\Users\\…\\.ollama\\models", "total_bytes": 1000000000000, "free_bytes": 400000000000 }
  }
}
```

`runtime.ok: false` is not an HTTP error: the status has to be viewable exactly when something does not work. `gpus` is empty without `nvidia-smi`; `disk` shows the free space where the models live (before the first download — in the nearest existing parent folder).

## The OpenAI-compatible API: `/v1/*`

The agent passes `GET|POST /v1/*` to the engine unchanged (the request body byte for byte, the SSE stream without buffering). When the client (the hub) disconnects, the agent aborts the request to the engine, so nothing is generated "into the void". If the engine is not running, the agent tries to start it, and when that fails it answers `503 runtime_unavailable` (the hub reports it to the client as a provider failure with `"fallback": true`, so the app may pick another model).

The one exception is **`GET /v1/models`**. The agent answers it itself, in the OpenAI format extended with fields the hub understands without special code for the agent:

```json
{
  "object": "list",
  "data": [{
    "id": "qwen3:4b", "object": "model", "created": 1790000000, "owned_by": "ollama",
    "kind": "chat",                                     // "chat" | "embedding"
    "locality": "local",
    "tags": [],                                         // "uncensored" for names with "abliterated" / "uncensored"
    "context_length": 8192,                             // min(model, OLLAMA_CONTEXT_LENGTH)
    "supported_parameters": ["tools", "reasoning"],     // from the capabilities the engine reports
    "architecture": { "input_modalities": ["text"], "output_modalities": ["text"] }
  }]
}
```

The `supported_parameters` and `architecture` fields are left out when the engine does not report capabilities (an old Ollama): "I don't know" is not "it can't". During a sync the hub stores what came; the owner's manual corrections (name, tags, context) take precedence and survive later syncs.

## Models

### `GET /node/models`

A richer list than `/v1/models` — for the panel.

```json
{ "object": "list", "data": [{
  "id": "qwen3:4b", "kind": "chat", "size_bytes": 2600000000, "digest": "sha256:…", "modified_at": "…",
  "family": "qwen3", "parameter_size": "4.0B", "quantization": "Q4_K_M", "context_length": 40960,
  "capabilities": ["completion", "tools", "thinking"], "tags": [],
  "loaded": { "vram_bytes": 2700000000, "size_bytes": 3100000000, "expires_at": "…" }   // null when not in memory
}] }
```

### Downloads (in the background)

Downloading a model takes minutes, so it is a job: you start it, then watch the progress. One runs at a time; the others wait (`queued`). Asking again for a model that is already downloading returns the same job. A download that reports no progress for 10 minutes is given up (`failed`, with the reason) — otherwise a dead connection would keep the machine "busy" and block the idle shutdown; start it again and Ollama resumes where it stopped.

| Call | Effect |
|---|---|
| `POST /node/pulls {"name": "qwen3:4b"}` | `202` and the job |
| `GET /node/pulls` | the list, newest first (the last 50 finished ones) |
| `GET /node/pulls/:id` | one job |
| `DELETE /node/pulls/:id` | aborts a running one (the engine gets a dropped connection); removes a finished one from the list |

```json
{ "id": "…", "name": "qwen3:4b", "status": "running", "phase": "pulling 6e4c38e1172f",
  "completed": 1300000000, "total": 2600000000, "percent": 50, "error": null,
  "created_at": "…", "started_at": "…", "finished_at": null }
```

`status`: `queued` → `running` → `succeeded` | `failed` | `cancelled`. `total` grows as the engine reports further layers, so the percentage can be inaccurate at the start. `error` carries the engine's reason (for example "pull model manifest: file does not exist").

The name is whatever the engine accepts: `qwen3:4b`, `hf.co/user/repo:Q4_K_M`, `registry.ollama.ai/library/…`.

### Deleting, loading

| Call | Effect |
|---|---|
| `DELETE /node/models/<name>` | deletes from the disk (the name in the path, `/` stays, `:` may be encoded as `%3A`) |
| `POST /node/models/load {"name", "keep_alive"?}` | loads into memory before the first request; `keep_alive` as in Ollama (`"10m"`, `-1` = until freed) |
| `POST /node/models/unload {"name"}` | frees the card's memory |

Embedding models are loaded and unloaded through `/api/embed`, because they cannot "generate".

## Power

### `POST /node/power/shutdown-request {"idle_minutes": 15}`

This is how the hub asks after a period of inactivity. The answer is always `200` with `{ "allow": bool, "reason": string }`; the hub counts a shutdown only when `allow: true`.

| `reason` | `allow` | Meaning |
|---|---|---|
| `shutdown_initiated` | true | the system command went out; the computer shuts down after `MINDGATE_SHUTDOWN_DELAY_SECONDS` |
| `shutdown_in_progress` | true | it is already shutting down |
| `requests_in_flight` | false | a request is in progress |
| `download_in_progress` | false | a download is in progress |
| `user_active` | false | (without a tray) someone reported that they are using the PC |
| *the tray's reason* (for example `user_toggle_active`, `user_recently_active`) | false | the tray refused |
| `tray_unreachable` | false | the tray was supposed to answer and did not |
| `shutdown_failed` | false | the system refused to run the command (Linux: no sudo rule) |

### `POST /node/power/shutdown {"force": false}`

As above, but on a person's decision. `force: true` skips the checks (the answer has `reason: "forced"`).

### `POST /node/user-active {"active": true, "last_input_seconds_ago": 12}`

The tray reports whether someone is sitting at the computer (visible in `/node/status`).

### `POST /node/exit`

The tray asks the agent to stop (the agent answers, after half a second stops the engine it started itself, and exits; as a Windows service it stops the service as well).

## What the hub does with a node

- **Checks the state**: `GET <control_url>/health` (by default; `node.health_url` overrides it) on a request when the last answer is older than 30 s, and every 30 s in the background. Any answer below 500 means "the machine is up".
- **Wakes** (Wake-on-LAN) only when a client request needs it and has a sufficient priority. Model management from the panel **never** wakes the machine — a person should see that it sleeps and decide for themselves (the "Wake" button).
- **Syncs the model list** from the agent's `GET /v1/models`: after a start, every `MINDGATE_SYNC_INTERVAL_HOURS`, on demand, after a download finishes, after a model is deleted.
- **Watches the downloads it ordered itself** (every 2 s), so that a finished model appears in the catalogue even when nobody has the panel open. Downloads ordered another way (for example from a command line on the machine) are picked up at the next look at the job list or at an ordinary sync.
- **Asks for a shutdown** after `node.idle_shutdown_minutes` without requests through the hub: `POST <control_url>/node/power/shutdown-request`. A "no" means: ask again no sooner than in 5 minutes. An answer without the `allow` field (your own script that returns a bare `200`) is treated by the hub as a "yes".

## Your own agent

The minimum for a machine to be a useful provider: an OpenAI-compatible server at `base_url` with `GET /models` (no agent at all). For management from the hub you add: `GET /health`, `GET /node/status`, `GET|POST|DELETE /node/pulls…`, `GET /node/models`, `DELETE /node/models/*`, `POST /node/models/load|unload`, `POST /node/power/shutdown-request` and `shutdown` — in exactly the shapes above. The fake agent the hub is tested against is `startFakeAgent` in `gate/src/__tests__/helpers.ts`; the reference for a real implementation is `agent/src/routes-node.ts`. An engine other than Ollama is one class that implements the `Runtime` interface (`agent/src/runtime.ts`).
