# Client configuration

MindGate exposes an OpenAI-compatible API. Configuring any client comes down to three things: the URL, the API key, the model name.

The **model name** is one of two things:

- an **alias** — a short name that you set in the hub (`smart`, `flash`, `coding-hard`), with an explicit list of backup models; you change what is behind it without touching the clients,
- a **provider model** — `provider/model`, for example `openrouter/deepseek/deepseek-chat`; with no fallback at all.

`GET /v1/models` shows what is available (clients show this list themselves). Every client should have **its own key** (`keys create <name>`): separate limits, priority and, if needed, `--local-only`. Aliases, keys and limits are described in [01 - Hub](01-gate.md); all endpoints and error codes in [08 - API](08-api.md).

Client settings and file formats change from version to version. The values to enter are always the same — base URL `https://hub.example.com/v1`, key `mg-…`, model name — and where they go is in the client's own documentation. The sections below are examples that were current when they were written.

---

## Open WebUI

Open WebUI is a browser front end for LLMs — a good main interface for chatting.

### Installation (Docker, on any machine)

```bash
docker run -d \
  --name open-webui \
  -p 3000:8080 \
  -e OPENAI_API_BASE_URL=https://hub.example.com/v1 \
  -e OPENAI_API_KEY=mg-your-key \
  ghcr.io/open-webui/open-webui:main
```

Open: http://localhost:3000

### Adding the models

In Open WebUI: **Settings** → **Connections** → **OpenAI API**:
- URL: `https://hub.example.com/v1`
- Key: `mg-your-key`

The models appear automatically (the hub returns the list through `/v1/models`).

### Priority in Open WebUI

Open WebUI does not send custom headers — requests will have the default priority of your API key. If you want a higher priority for particular conversations, configure a separate key with a higher `--priority`. Conversations with private data can be sent through a separate connection with a `--local-only` key: the hub will not send them to the cloud, even by a mistake in choosing the model.

---

## Continue (VS Code / JetBrains)

Continue is an extension for VS Code and JetBrains: a coding assistant.

Install the **Continue** extension, then add the hub to its configuration (`~/.continue/config.yaml`):

```yaml
name: MindGate
version: 1.0.0
schema: v1
models:
  - name: MindGate Smart
    provider: openai
    model: smart
    apiBase: https://hub.example.com/v1
    apiKey: mg-your-key
    roles: [chat, edit, apply]
  - name: MindGate Fast
    provider: openai
    model: coding-fast
    apiBase: https://hub.example.com/v1
    apiKey: mg-your-key
    roles: [autocomplete]
```

---

## Cursor

Cursor accepts a custom OpenAI endpoint: in **Settings** → **Models**, enter your key as the OpenAI API key, turn on the base-URL override and set it to `https://hub.example.com/v1`, then add the alias (for example `coding-hard`) as a custom model name.

---

## Your own script / application

Every OpenAI-compatible library works straight away.

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://hub.example.com/v1",
    api_key="mg-your-key"
)

response = client.chat.completions.create(
    model="smart",
    messages=[
        {"role": "user", "content": "Explain quicksort to me"}
    ],
    extra_headers={
        "X-MindGate-Priority": "3",        # 1-5, within the range allowed for the key
        "X-MindGate-Local-Only": "true",   # optional: local models only, fallbacks too
    }
)
print(response.model)   # who really answered, for example "openrouter/deepseek/deepseek-chat"
print(response.choices[0].message.content)
```

### Node.js

```javascript
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'https://hub.example.com/v1',
  apiKey: 'mg-your-key',
  defaultHeaders: {
    'X-MindGate-Priority': '2'
  }
})

const response = await client.chat.completions.create({
  model: 'flash',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true
})

for await (const chunk of response) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
}
```

---

## Local network vs outside

### Local network only (no domain)

If you do not need access from outside your home, you can use the Raspberry Pi's local IP:

- URL: `http://192.168.1.50:3000/v1` (no HTTPS)
- You do not need a TLS certificate

The nginx configuration is then optional — the hub can be exposed directly.

### Access from outside (a home server)

Option 1 — **port forwarding**: forward port 443 on the router to the Raspberry Pi, use Let's Encrypt.

Option 2 — **Tailscale / Cloudflare Tunnel**: a VPN mesh or a tunnel with no open ports. Recommended for security.

Tailscale is the simplest:

```bash
# On the Raspberry Pi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# URL in the clients: http://100.x.x.x:3000/v1 (the Tailscale IP)
```

---

## The model list — the /v1/models endpoint

The hub returns the models and aliases available to a given key through the standard endpoint:

```bash
curl https://hub.example.com/v1/models \
  -H "Authorization: Bearer mg-your-key"
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "smart", "object": "model", "owned_by": "mindgate",
      "name": "smart", "description": "", "kind": "chat", "tags": [],
      "locality": "cloud", "alias_of": ["openrouter/deepseek/deepseek-chat", "openrouter/google/gemini-2.5-flash"],
      "context_length": 64000, "status": "online"
    },
    {
      "id": "pc/qwen3:4b", "object": "model", "owned_by": "pc",
      "kind": "chat", "supports": ["tools"], "locality": "local", "context_length": 8192, "status": "asleep"
    }
  ]
}
```

Besides the OpenAI fields there are extras that a client may ignore: `kind` (`chat` / `embedding`), `tags`, `locality` (`local` / `cloud`), `context_length`, `supports` (when the provider reports capabilities) and `status` (`online` / `asleep` / `waking` — for machines that sleep). Fields the provider says nothing about are left out — a missing field means "unknown", not "not supported".

A key with `allowed_models` sees only its own models; a call with `local_only` (key or header) sees only those it can reach.

---

## Usage and limits from the client's side

```bash
curl https://hub.example.com/v1/usage -H "Authorization: Bearer $MINDGATE_KEY"
```

Returns the usage today and this month, the key's limits, and the moment when the day and the month reset. After a limit is exceeded the client gets `429` with the code `rate_limited` (too fast: wait `Retry-After` seconds) or `budget_exhausted` (the daily or monthly limit is used up: `reset_at` says when it comes back) — it is worth telling them apart.
