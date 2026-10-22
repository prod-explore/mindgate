# The hub API

All error responses use the OpenAI format:

```json
{ "error": { "message": "…", "type": "invalid_request_error", "code": "model_not_found", "param": "model" } }
```

The same API serves the [panel](09-panel.md) — nothing the panel does bypasses these endpoints.

`code` is stable and meant for programs; `message` is for people. Every response has an `X-Request-Id` (if a client sends its own `X-Request-Id` of a sensible shape, the hub keeps it), and the same identifier is in the request log.

---

## The client API

Authentication: `Authorization: Bearer mg-…` (a client key). `GET /health` needs no key and reveals nothing.

### `POST /v1/chat/completions`

Compatible with OpenAI Chat Completions, including `stream: true`, tools (`tools`), images and `response_format`. Unknown parameters are passed to the provider unchanged. An Anthropic model is translated: `system`/`developer`, tools, images, the thinking budget from `reasoning_effort` / `reasoning.max_tokens`, `reasoning_details` (signatures), cache usage; `n > 1` ends in `400`.

| Request header | Meaning |
|---|---|
| `X-MindGate-Priority: 1–5` | priority in the queue and the threshold for waking a machine; clamped to the key's range |
| `X-MindGate-Local-Only: true` | local models only (cloud targets, fallbacks included, are skipped) |
| `X-MindGate-Model` | the model, when the `model` field is inconvenient (takes precedence over the field) |
| `X-MindGate-Tag` | a label (`[\w.:@/-]{1,64}`) stored in the log, for example an application name |
| `X-Request-Id` | your own request identifier |

| Response header | Meaning |
|---|---|
| `X-MindGate-Model`, `X-MindGate-Provider` | who really answered |
| `X-MindGate-Fallback` | the models that failed before the last one answered (only when a fallback was used) |

The response (not the stream) also has a `mindgate` object: `{ requested, model, provider, attempts: [{model, outcome}], usage_estimated? }`. `model` in the body is always the canonical identifier `provider/model`.

Streaming: `stream_options.include_usage` works as in OpenAI (the hub asks the provider for usage itself, to count it, but shows it only when the client asked). When an answer takes long, comments `: waiting for the model` appear in the stream. An error after the stream has started arrives as a `data: {"error": …}` event and `data: [DONE]` (the HTTP status has already been sent by then).

### `POST /v1/embeddings`

As in OpenAI; the model must be of type `embedding`.

### `GET /v1/models`, `GET /v1/models/{id}`

See [07 - Clients](07-clients.md). `{id}` may contain `/`.

### `GET /v1/usage`

```json
{
  "object": "usage",
  "key": { "id": "key_…", "name": "laptop", "prefix": "mg-AbCdE", "local_only": false },
  "period": { "day": "2026-10-13", "resets_at": "2026-10-13T22:00:00.000Z", "month_resets_at": "2026-10-31T23:00:00.000Z", "time_zone": "Europe/Warsaw" },
  "requests": { "today": 12, "per_day": 200, "last_minute": 1, "per_minute": 30 },
  "tokens": {
    "today": { "input": 8000, "output": 2500, "total": 10500, "limit": 500000 },
    "month": { "input": 90000, "output": 30000, "total": 120000, "limit": null }
  },
  "by_model": [ { "model": "openrouter/deepseek/deepseek-chat", "requests": 12, "errors": 0, "input_tokens": 8000, "output_tokens": 2500 } ]
}
```

It works for a key that has used up its limit as well.

---

## Error codes

| Status | `code` | When |
|---|---|---|
| 400 | `missing_model`, `invalid_messages`, `invalid_request`, `invalid_json`, `invalid_priority` | a malformed request |
| 400 | `unsupported_content`, `unsupported_parameter`, `unsupported_endpoint` | the provider cannot do this: a content type or parameter the Anthropic translation does not support (`n > 1`), embeddings on a provider that does not offer them |
| 400 / 404 / 409 | `invalid_*`, `*_not_found`, `*_exists` | (administrator API only) validation of what you sent — `invalid_provider_id`, `invalid_base_url`, `invalid_targets`, `invalid_key_name`…; an unknown `provider` / `alias` / `key` / `model`; a duplicate. `param` names the field |
| 400 | `wrong_model_kind` | an embedding model in a chat, or the other way round |
| 400 | `context_length_exceeded` and other provider codes | the provider rejected the content of the request — passed on unchanged, **with no fallback** |
| 400 | `upstream_bad_request` | as above, when the provider gave no recognisable code |
| 400 | `not_a_node`, `no_agent`, `agent_rejected` | (administrator API only) the provider has no `node` settings / no `node.control_url` / the agent rejected the command (for example a wrong model name) |
| 401 | `missing_auth_header`, `invalid_auth_format`, `invalid_api_key` | authentication |
| 401 | `invalid_admin_token` | (administrator API) a missing or wrong `MINDGATE_ADMIN_TOKEN` |
| 403 | `model_not_allowed` | the key does not have this model in its `allowed_models` list |
| 403 | `local_only_violation` | `local_only`, and the model/alias has no local target |
| 404 | `model_not_found`, `unknown_endpoint` | an unknown model, alias (or a disabled one) / path |
| 413 | `request_too_large` | above `MINDGATE_BODY_LIMIT_MB` |
| 429 | `rate_limited` | too many requests per minute; the `Retry-After` header, the `retry_after` field |
| 429 | `budget_exhausted` | the daily/monthly limit; the `limit` field (`requests_per_day`, `tokens_per_day`, `tokens_per_month`) and `reset_at` |
| 429 | `too_many_auth_failures` | the address is blocked after 20 failed sign-ins per minute |
| 429 | `upstream_rate_limited` | a limit on the provider's side (with its `Retry-After`) |
| 429 | `upstream_quota_exhausted` | the provider's quota or credit is used up (the subscription wrapper's `budget_exhausted`, OpenAI's `insufficient_quota`); `reset_at` when the provider says when it comes back, `Retry-After` in seconds |
| 500 | `internal_error` | a bug in the hub; the details are in its log under the same `X-Request-Id` |
| 502 | `upstream_error`, `upstream_unreachable`, `upstream_empty_response`, `upstream_invalid_response`, `upstream_auth_failed` | a provider failure / a wrong provider key (the owner's, not the client's) |
| 502 | `node_connection_lost` | the machine disappeared mid-request, and the retry failed too |
| 502 | `node_auth_failed`, `agent_missing`, `agent_invalid_response`, `agent_error` | machine management (`/admin/api/providers/{id}/node*`): the agent rejected the secret / there is no MindGate agent at `control_url` / it answered with something that is not JSON / it reported an error on its side |
| 502 | `provider_secret_unreadable` | `MINDGATE_MASTER_KEY` was changed — enter the provider's key again |
| 503 | `no_available_model` | no target of the alias is available (providers disabled) |
| 503 | `node_asleep` | the machine sleeps, and the request's priority is too low to wake it |
| 503 | `node_unavailable`, `wol_failed` | the machine did not come up in time / the packet could not be sent |
| 503 | `queue_full`, `upstream_overloaded` | the provider's queue is full / the provider is overloaded |
| 504 | `queue_timeout`, `upstream_timeout` | waiting for too long |
| in the stream | `upstream_stream_interrupted` | the provider broke off the answer midway |

An alias falls back on provider failures: `upstream_error`, `upstream_unreachable`, `upstream_overloaded`, `upstream_timeout`, `upstream_rate_limited`, `upstream_quota_exhausted`, `upstream_empty_response`, `upstream_invalid_response`, `upstream_auth_failed`, `upstream_stream_interrupted`, when the provider does not know the model (`model_not_found` from the provider), `node_*`, `wol_failed`, `queue_full`, `queue_timeout` — and only before the client has received the first content. Errors of the request itself (`400`, `403`, a key's `429`) never trigger a fallback.

---

## The administrator API — `/admin/api`

`Authorization: Bearer $MINDGATE_ADMIN_TOKEN`. JSON in `snake_case`. Responses carry `Cache-Control: no-store`. Provider and client keys never come back: a provider shows `has_api_key` and the last 4 characters (`api_key_hint`), a client — the prefix.

| Method and path | What for |
|---|---|
| `GET /status` | version, uptime, the state of providers and queues, counters |
| `GET /presets` | ready-made provider settings (OpenRouter, Gemini, Anthropic, OpenAI, Ollama, LM Studio, custom, `mindgate-node` — a machine with a MindGate agent) |
| `GET /providers`, `GET /providers/{id}` | the list / one provider |
| `POST /providers` | add: `id`, `type` (`openai` / `anthropic`), `base_url`, `api_key`, `locality`, `auth_scheme` (`bearer` / `header` / `none`) + `auth_header`, `extra_headers`, `options`, `max_concurrency`, `node`, `enabled`. It fetches the model list right away (`"sync": false` turns that off) |
| `PATCH /providers/{id}` | change any of the fields; `api_key: null` removes the key, a missing field leaves it alone |
| `DELETE /providers/{id}` | removes the provider with its models; the response lists the aliases that lost a target (`aliases_affected`) |
| `POST /providers/{id}/test` | checks the connection without changing anything (`ok`, latency, number of models) |
| `POST /providers/{id}/sync` | refreshes the model list |
| `POST /providers/{id}/wake` | wakes the machine (a provider with `node`) and waits |
| `GET /providers/{id}/node` | the machine: the state known to the hub + what its agent says (`agent`: the model in memory, jobs in progress, CPU/RAM/GPU/disk; `agent_error` when the agent does not answer) |
| `GET /providers/{id}/node/models` | the models installed on the machine (size, quantisation, capabilities, `loaded`) together with the record in the hub (`hub_id`, `hub`) |
| `POST /providers/{id}/node/pulls` | download a model: `{"name":"qwen3:4b"}` or `hf.co/…`; `202` + a job with an `id`. When it finishes, the model goes into the hub's catalogue by itself |
| `GET /providers/{id}/node/pulls`, `GET …/pulls/{pull}`, `DELETE …/pulls/{pull}` | download jobs, progress (`status`, `percent`, `completed`, `total`), cancelling |
| `POST /providers/{id}/node/models/load`, `…/unload` | load into the card (`name`, optionally `keep_alive`: `"30m"`, `-1`) / free it |
| `DELETE /providers/{id}/node/models/{name}` | delete from the machine's disk and from the hub's catalogue; the response lists the aliases that lost a target (`aliases_affected`) |
| `POST /providers/{id}/node/shutdown` | shut the machine down; `{"force":true}` skips the checks that protect a busy computer from being shut down |
| `GET /models[?provider=]` | the models with the fields `reported` (what the provider said) and `overrides` (what the owner set) |
| `POST /models` | add a model by hand (`provider`, `id`, optionally `name`, `kind`, `context_length`, …) |
| `PATCH /models/{id}` | override `name`, `description`, `kind`, `tags`, `context_length`, `max_output_tokens`, `supports`, `locality`, `enabled`; `null` restores the provider's value |
| `DELETE /models/{id}` | a manual model disappears; a synced one is disabled |
| `GET /aliases`, `POST /aliases`, `PATCH /aliases/{name}`, `DELETE /aliases/{name}` | aliases: `name` (without `/`), `targets` (the order = the fallback order, up to 8), `description`, `tags`, `enabled` |
| `GET /keys`, `POST /keys` | client keys; `POST` returns the full key in the `key` field **once** |
| `PATCH /keys/{id}`, `POST /keys/{id}/revoke`, `DELETE /keys/{id}` | changing limits and restrictions, revoking (the history stays), deleting |
| `GET /usage[?from=&to=&key=&model=]` | daily totals (30 days by default) |
| `GET /log[?limit=&before=&key=&errors=1]` | the request log: without conversation content |

A model's `{id}` contains `/` (for example `openrouter/deepseek/deepseek-chat`) and goes into the path as it is.

### Provider settings (`options`)

| Option | Meaning |
|---|---|
| `first_byte_timeout_ms`, `idle_timeout_ms` | how long to wait for the first byte and for silence between chunks (a cold local model can take minutes to load); at most 1 h |
| `stream_usage` | whether to ask the provider for `stream_options.include_usage` (on by default; turn it off for servers that reject it) |
| `default_max_tokens` | Anthropic requires `max_tokens`; the value used when the client gives none |
| `models_path`, `chat_path`, `embeddings_path` | for servers with a layout different from OpenAI's |
| `auto_enable_models` | new models start enabled (the default); turn it off for catalogues with hundreds of models |

### `node` (a machine that sleeps)

`mac`, `broadcast`, `port` (9), `min_wake_priority` (3), `boot_timeout_ms` (120000), `poll_interval_ms` (2000), `control_url` (the address of the MindGate agent, for example `http://pc.lan:3001` — turns on model management and the default `health_url` and `shutdown_url`), `health_url`, `shutdown_url`, `idle_shutdown_minutes` (needs `shutdown_url` or `control_url`). See [06 - Wake-on-LAN](06-wol.md) and [05 - Node protocol](05-nodes.md).

The agent's secret (`MINDGATE_NODE_SECRET`) is the provider's `api_key` — encrypted like any other, and it never comes back in responses.
