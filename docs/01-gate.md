# Hub (gate) — Raspberry Pi

The hub is the single entry point to MindGate: one OpenAI-compatible API with **providers** behind it — a local GPU machine (woken by Wake-on-LAN), OpenRouter, Gemini, Anthropic, Ollama, anything that speaks HTTP. A client knows one address and one key; the hub decides where each request goes, enforces limits and stores nothing but numbers.

It runs on a Raspberry Pi 4+ (ARM64, 2 GB of RAM is enough) or on any Linux box with Docker or Node 22.

---

## Installation (Docker)

```bash
git clone https://github.com/prod-explore/mindgate.git
cd mindgate/gate

cp .env.example .env
# put two different secrets (each: openssl rand -hex 32) into MINDGATE_MASTER_KEY and MINDGATE_ADMIN_TOKEN
nano .env

docker network create mindgate_net      # shared with nginx; skip it if you remove the network from docker-compose.yml
docker compose up -d --build
docker compose logs -f gate
```

`docker-compose.yml` does not publish the hub's port: a reverse proxy in the same Docker network reaches it as `mindgate-gate:3000` ([below](#reverse-proxy-nginx)). With nothing in front — trying it out, or a hub used only from this machine — add the file that publishes it on the loopback interface:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

The hub **will not start** with the placeholders from `.env.example`, or with a short or repetitive secret — on purpose.

- `MINDGATE_MASTER_KEY` encrypts the providers' API keys stored in the database (AES-256-GCM). **Keep a copy separate from the database backups**: without it the stored provider keys cannot be read and have to be entered again.
- `MINDGATE_ADMIN_TOKEN` protects `/admin`. It must differ from the master key.

Once the hub is running, the **panel** is waiting at `http://localhost:3000/admin/` with the port published as above, or at your proxy's address (sign in with that token): providers, models, keys, usage, the log and the GPU machines — everything you do with `curl` below can be clicked there. Details: [09 - Panel](09-panel.md).

### Without Docker

```bash
cd mindgate/panel && npm ci && npm run build      # the panel (into panel/dist); without it /admin/ is disabled, the API still works
cd ../gate
npm ci
npm run build
npm start          # reads .env from the current directory (Node >= 22.9)
```

---

## First steps

Everything below is a call to the administrator API (`/admin/api`, header `Authorization: Bearer $MINDGATE_ADMIN_TOKEN`). The full list: [08 - API](08-api.md). You can do the same in the [panel](09-panel.md).

```bash
HUB=http://localhost:3000
ADMIN="Authorization: Bearer <MINDGATE_ADMIN_TOKEN>"

# 1. A provider. Ready-made settings: GET /admin/api/presets
curl -X POST $HUB/admin/api/providers -H "$ADMIN" -H 'Content-Type: application/json' -d '{
  "id": "openrouter", "type": "openai", "base_url": "https://openrouter.ai/api/v1",
  "api_key": "sk-or-...", "locality": "cloud",
  "options": { "auto_enable_models": false }
}'
# the hub fetches the model list right away; OpenRouter has hundreds, so they stay disabled until you enable them:
curl -X PATCH $HUB/admin/api/models/openrouter/deepseek/deepseek-chat -H "$ADMIN" -H 'Content-Type: application/json' -d '{"enabled": true}'

# 2. A second model, for an app that wants a backup of its own (the hub never switches models for it)
curl -X PATCH $HUB/admin/api/models/openrouter/google/gemini-2.5-flash -H "$ADMIN" -H 'Content-Type: application/json' -d '{"enabled": true, "tags": ["fast"]}'

# 3. A key for a client (the full key is shown ONLY NOW)
docker compose exec gate node dist/cli.js keys create laptop --rpm 30 --tokens-day 500000
```

In the client: the hub's address with `/v1` (for example `https://hub.example.com/v1` behind a proxy, or `http://localhost:3000/v1` with the local port), key `mg-…`, model `openrouter/deepseek/deepseek-chat`.

---

## How the hub handles a request

```
key → model → limits → wake the machine → wait for a free slot → provider → response
```

1. **Key.** Only a hash (SHA-256) is stored; the client shows `mg-…` and the hub compares hashes.
2. **Model.** `provider/model` (for example `openrouter/deepseek/deepseek-chat`) is one provider's model. There are no other names (no aliases): a name without a provider is a `404 model_not_found`. Nothing is guessed.
3. **Key limits** — see below. A rejected request never reaches a model and costs nothing.
4. **Provider.** If the provider is a machine that sleeps, the hub wakes it and waits. If the provider handles one request at a time, the request waits in a queue ordered by priority.
5. **Response** comes back in the OpenAI format (from Anthropic too — the hub translates tools, images, thinking and the stream). The `X-MindGate-Model` and `X-MindGate-Provider` headers say who answered; the body also has a `mindgate` object (`requested`, `model`, `provider`, `attempts`).

### No silent substitution — fallback is the app's job

- The hub **never** answers with another model than the one asked for. A provider error is an error for the client.
- When a failure is one that another model could fix (5xx, a provider-side rate limit, a timeout, no connection, a sleeping or unreachable machine, a full queue), the error body carries `"fallback": true`. The app then picks another model itself — typically by the **tags** it finds in `GET /v1/models` (`free`, `coder`, `vision`, … set per model in the panel) — and asks again. Request errors (for example a context that is too long) never carry the flag: the same request would fail everywhere.
- When an answer is already streaming and the provider breaks off, the stream ends with an error event without the flag — nobody finishes someone else's sentence with another model.

### Local-only mode

Private data must not reach the cloud, so `local_only` is enforced by the hub on every request:

- on a key: `keys create name --local-only` (the client cannot switch it off),
- on a request: the header `X-MindGate-Local-Only: true`.

A model is local if its provider is marked `locality: local` (Ollama, a GPU machine) — and the owner can override this per model. A cloud model is refused *without sending it anything*: `403 local_only_violation`. `/v1/models` shows such a call only what is reachable for it.

### Client keys and limits

Every client has its own key with settings:

| Setting | Meaning |
|---|---|
| `rpm` | requests per minute → `429 rate_limited` + `Retry-After` |
| `rpd` | requests per day → `429 budget_exhausted` + `reset_at` |
| `tokens_per_day`, `tokens_per_month` | token budget (input + output) → `429 budget_exhausted` + `reset_at` |
| `min_/default_/max_priority` | the 1–5 priority range a client may ask for |
| `local_only` | see above |
| `allowed_models` | a list of model ids and `provider/*` patterns: `pc/*`, `openrouter/deepseek/deepseek-chat`; `null` = everything |

A "day" and a "month" start at midnight in the `MINDGATE_USAGE_TZ` time zone (for example `Europe/Warsaw`), including on daylight-saving days. A client checks its own usage at `GET /v1/usage`.

The token budget counts finished requests; requests that are still running may go slightly over it — the refusal comes with the next one. `rpm` is kept in memory (a hub restart lets through at most one burst).

### Priorities and the queue

`X-MindGate-Priority: 1–5` (by default from the key, clamped to the key's range). A provider with `max_concurrency` (for example 1 for a single GPU) has a queue: 5 before 1, and first come first served within a priority. The queue has a size limit (`MINDGATE_QUEUE_MAX`) and an optional wait limit (`MINDGATE_QUEUE_TIMEOUT_MS`); a client that disconnects drops out of the queue and does not hold a place.

### A machine that sleeps (Wake-on-LAN)

A provider with `node` set is a computer the hub wakes:

- a request with priority `>= min_wake_priority` (3 by default) sends a magic packet and waits (up to `boot_timeout_ms`), and while streaming, when it gets quiet, sends SSE comments (`MINDGATE_KEEPALIVE_*`) so that nginx and the client do not drop the connection;
- a request with a lower priority **does not wake** the machine: it gets `503 node_asleep` with `"fallback": true`, so the app can ask a cloud model instead at once;
- many requests waiting for the same machine are one wake-up;
- after `idle_shutdown_minutes` without requests the hub asks the agent to shut down (`POST <control_url>/node/power/shutdown-request`, or your own `shutdown_url`); the agent decides whether to actually do it (a request or download is running, someone is working at the computer). A refusal or an error means a 5-minute pause before the hub asks again;
- when the machine disappears mid-request (power), the hub checks it again, wakes it if needed and retries **once**; after that, `502 node_connection_lost`.

With `node.control_url` (the address of the MindGate agent, for example `http://pc.lan:3001`) the hub also manages the **models on the machine**: it downloads them, deletes them, loads them into the card and shows the state of the hardware — [05 - Nodes](05-nodes.md), [04 - Models](04-models.md). The hub does **not** wake the machine for something like that; if it is asleep, you get a clear error.

Wake-on-LAN setup on the computer and the router: [06 - Wake-on-LAN](06-wol.md).

### What the hub stores

In the request log: when, which key, which model and provider, the response code, timings (queue, first byte, total), the token counts, how the attempt ended. **Never the content of a conversation** — neither the question nor the answer. The log is purged after `MINDGATE_LOG_RETENTION_DAYS` (30). The daily totals used for limits stay.

---

## Backup

```bash
docker compose exec gate node dist/cli.js backup --keep 7
```

A consistent copy (even while the hub is running) goes to `/data/backups`, verified. The provider keys in it are encrypted with `MINDGATE_MASTER_KEY` — keep the database copy and the master key apart. `node dist/cli.js check [--online]` checks the configuration, the database and (optionally) connectivity to the providers.

---

## Reverse proxy (nginx)

The hub listens on 3000 in the Docker network. Behind a proxy set `MINDGATE_TRUST_PROXY=true`, so that the sign-in attempt limit counts the real client address.

```nginx
server {
    listen 443 ssl;
    server_name hub.example.com;

    ssl_certificate     /etc/letsencrypt/live/hub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hub.example.com/privkey.pem;

    client_max_body_size 25m;

    location / {
        proxy_pass http://mindgate-gate:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;          # the SSE stream has to flow as it is produced
        proxy_read_timeout 3600s;     # long answers of big models
        proxy_send_timeout 3600s;
    }
}
```

`/admin` has its own token, but there is no reason to expose it to the internet: in nginx you can restrict it to the local network (`location /admin { allow 192.168.0.0/16; deny all; … }`).

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `MINDGATE_MASTER_KEY` | — (required) | encrypts the providers' keys in the database |
| `MINDGATE_ADMIN_TOKEN` | — (required) | the `/admin` token, different from the master key |
| `MINDGATE_DB` | `./data/mindgate.db` (`/data/mindgate.db` in Docker) | the SQLite file (mode 600) |
| `MINDGATE_HOST`, `MINDGATE_PORT` | `0.0.0.0`, `3000` | where it listens |
| `MINDGATE_USAGE_TZ` | `UTC` | the time zone in which a day/month for limits starts |
| `MINDGATE_TRUST_PROXY` | `false` | trust `X-Forwarded-For` |
| `MINDGATE_BODY_LIMIT_MB` | `20` | maximum request size |
| `MINDGATE_QUEUE_MAX`, `MINDGATE_QUEUE_TIMEOUT_MS` | `100`, `0` | the queue of a provider with `max_concurrency` (0 = no time limit) |
| `MINDGATE_LOG_RETENTION_DAYS` | `30` | how long the request log is kept |
| `MINDGATE_LOG_LEVEL` | `info` | the process log level |
| `MINDGATE_KEEPALIVE_AFTER_MS`, `…_INTERVAL_MS` | `10000` | SSE comments during a long wait |
| `MINDGATE_FIRST_BYTE_TIMEOUT_MS`, `MINDGATE_IDLE_TIMEOUT_MS` | `300000`, `120000` | the default provider time limits (overridable per provider) |
| `MINDGATE_SYNC_INTERVAL_HOURS` | `24` | how often the model lists are refreshed |
| `MINDGATE_PANEL_DIR` | `panel/dist` next to `gate/` (`/app/panel` in Docker) | where the hub serves the panel from at `/admin/`; an empty value disables the panel |
| `MINDGATE_ALLOW_WEAK_SECRETS` | `false` | for local tests only: a weak secret becomes a warning |

---

## Code layout

```
gate/src/
├── index.ts, server.ts       process start, the Fastify server, error handling
├── routes-v1.ts              /v1/models, /v1/chat/completions, /v1/embeddings, /v1/usage
├── routes-admin.ts           /admin/api/* (providers, models, keys, usage, log)
├── panel.ts                  the panel files under /admin/ (GET/HEAD only, content policy, path protection)
├── chat.ts                   one request from the key to the last byte (waking, queue, SSE, accounting)
├── routing.ts                model id → the model and provider that serve it; local_only, allowed_models
├── limits.ts, queue.ts       key limits, the priority queue
├── node.ts                   machine state, waking, shutdown on idle
├── wol.ts                    the magic packet, and the client of the relay
├── wol-relay.ts              the relay: sends the packet from the host's network (own container)
├── adapters/                 openai (transparent, with Gemini's quirks smoothed over), anthropic (translation both ways)
├── store/                    providers, models, keys, usage (SQLite)
├── crypto.ts, db.ts, …       secret encryption, database migrations
└── cli.ts                    keys, backup, check
```

---

## Troubleshooting

**The hub does not start: "MINDGATE_MASTER_KEY is too weak"** — put in a real secret (`openssl rand -hex 32`); the placeholder from `.env.example` is rejected.

**`provider_secret_unreadable`** — `MINDGATE_MASTER_KEY` was changed. Restore the old one or enter the provider's key again (`PATCH /admin/api/providers/<id>` with `api_key`). `node dist/cli.js check` shows which providers are affected.

**`node_asleep` although I want to wake the machine** — the request's priority is lower than `min_wake_priority`. Send `X-MindGate-Priority: 3` or more, or wake it by hand: `POST /admin/api/providers/<id>/wake`.

**WoL does not work** — [06 - Wake-on-LAN](06-wol.md). Most often: WoL is off in the BIOS, or Fast Startup is on in Windows. `broadcast` must be the network's broadcast address, not the machine's own IP (a unicast packet is dropped once the machine's ARP entry has expired); when the hub runs on a Docker bridge it also needs the Wake-on-LAN relay ([06 - Wake-on-LAN](06-wol.md#hub-in-docker-the-relay)).

**`429 budget_exhausted`** — the client has used up its key's limit; `GET /v1/usage` says how much it used and when it comes back (`reset_at`).

**401** — the header is `Authorization: Bearer mg-…` (with a space after "Bearer"); after 20 wrong attempts the address is blocked for a minute.
