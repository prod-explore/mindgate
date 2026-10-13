# API huba

Wszystkie odpowiedzi błędów mają format OpenAI:

```json
{ "error": { "message": "…", "type": "invalid_request_error", "code": "model_not_found", "param": "model" } }
```

`code` jest stały i przeznaczony dla programów; `message` dla ludzi. Każda odpowiedź ma `X-Request-Id` (jeśli klient poda własny `X-Request-Id` o rozsądnym kształcie, hub go zachowa), a ten sam identyfikator jest w logu żądań.

---

## API dla klientów

Uwierzytelnienie: `Authorization: Bearer mg-…` (klucz klienta). `GET /health` nie wymaga klucza i niczego nie ujawnia.

### `POST /v1/chat/completions`

Zgodne z OpenAI Chat Completions, także `stream: true`, narzędzia (`tools`), obrazy i `response_format`. Nieznane parametry są przekazywane dostawcy bez zmian. Model z Anthropic jest tłumaczony: `system`/`developer`, narzędzia, obrazy, budżet myślenia z `reasoning_effort` / `reasoning.max_tokens`, `reasoning_details` (podpisy), zużycie z cache; `n > 1` kończy się `400`.

| Nagłówek żądania | Znaczenie |
|---|---|
| `X-MindGate-Priority: 1–5` | priorytet w kolejce i próg budzenia maszyny; obcinany do zakresu klucza |
| `X-MindGate-Local-Only: true` | tylko modele lokalne (cele w chmurze, także fallbacki, są pomijane) |
| `X-MindGate-Model` | model, gdy pole `model` jest niewygodne (ma pierwszeństwo przed polem) |
| `X-MindGate-Tag` | etykieta (`[\w.:@/-]{1,64}`) zapisywana w logu, np. nazwa aplikacji |
| `X-Request-Id` | własny identyfikator żądania |

| Nagłówek odpowiedzi | Znaczenie |
|---|---|
| `X-MindGate-Model`, `X-MindGate-Provider` | kto faktycznie odpowiedział |
| `X-MindGate-Fallback` | modele, które zawiodły zanim odpowiedział ostatni (tylko gdy użyto fallbacku) |

W odpowiedzi (nie w strumieniu) jest też obiekt `mindgate`: `{ requested, model, provider, attempts: [{model, outcome}], usage_estimated? }`. `model` w treści to zawsze identyfikator kanoniczny `dostawca/model`.

Strumień: `stream_options.include_usage` działa jak w OpenAI (hub sam prosi dostawcę o zużycie, żeby je policzyć, ale pokazuje je tylko, gdy klient poprosił). Gdy odpowiedź trwa długo, w strumieniu pojawiają się komentarze `: waiting for the model`. Błąd po rozpoczęciu strumienia przychodzi jako zdarzenie `data: {"error": …}` i `data: [DONE]` (status HTTP jest już wtedy wysłany).

### `POST /v1/embeddings`

Jak w OpenAI; model musi być typu `embedding`.

### `GET /v1/models`, `GET /v1/models/{id}`

Zob. [07 - Klienty](07-clients.md). `{id}` może zawierać `/`.

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

Działa także dla klucza, który wyczerpał limit.

---

## Kody błędów

| Status | `code` | Kiedy |
|---|---|---|
| 400 | `missing_model`, `invalid_messages`, `invalid_request`, `invalid_json`, `invalid_priority` | błędne żądanie |
| 400 | `wrong_model_kind` | model embeddingowy w czacie lub odwrotnie |
| 400 | `context_length_exceeded` i inne kody dostawcy | dostawca odrzucił treść żądania — przekazane bez zmian, **bez fallbacku** |
| 400 | `upstream_bad_request` | jw., gdy dostawca nie podał rozpoznawalnego kodu |
| 400 | `not_a_node`, `no_agent`, `agent_rejected` | (tylko API administratora) dostawca nie ma ustawień `node` / nie ma `node.control_url` / agent odrzucił polecenie (np. zła nazwa modelu) |
| 401 | `missing_auth_header`, `invalid_auth_format`, `invalid_api_key` | uwierzytelnienie |
| 403 | `model_not_allowed` | klucz nie ma tego modelu na liście `allowed_models` |
| 403 | `local_only_violation` | `local_only`, a model/alias nie ma celu lokalnego |
| 404 | `model_not_found`, `unknown_endpoint` | nieznany model, alias (lub wyłączony) / ścieżka |
| 413 | `request_too_large` | ponad `MINDGATE_BODY_LIMIT_MB` |
| 429 | `rate_limited` | za dużo żądań na minutę; nagłówek `Retry-After`, pole `retry_after` |
| 429 | `budget_exhausted` | limit dobowy/miesięczny; pole `limit` (`requests_per_day`, `tokens_per_day`, `tokens_per_month`) i `reset_at` |
| 429 | `too_many_auth_failures` | blokada adresu po 20 błędnych logowaniach na minutę |
| 429 | `upstream_rate_limited` | limit po stronie dostawcy (z jego `Retry-After`) |
| 502 | `upstream_error`, `upstream_unreachable`, `upstream_empty_response`, `upstream_invalid_response`, `upstream_auth_failed` | awaria dostawcy / zły klucz dostawcy (właściciela, nie klienta) |
| 502 | `node_connection_lost` | maszyna zniknęła w trakcie, a ponowienie też się nie udało |
| 502 | `node_auth_failed`, `agent_missing`, `agent_invalid_response`, `agent_error` | zarządzanie maszyną (`/admin/api/providers/{id}/node*`): agent odrzucił sekret / pod `control_url` nie ma agenta MindGate / odpowiedział czymś, co nie jest JSON-em / zgłosił błąd po swojej stronie |
| 502 | `provider_secret_unreadable` | zmieniony `MINDGATE_MASTER_KEY` — wpisz klucz dostawcy od nowa |
| 503 | `no_available_model` | żaden cel aliasu nie jest dostępny (dostawcy wyłączeni) |
| 503 | `node_asleep` | maszyna śpi, a priorytet żądania jest za niski, by ją budzić |
| 503 | `node_unavailable`, `wol_failed` | maszyna nie wstała w czasie / nie udało się wysłać pakietu |
| 503 | `queue_full`, `upstream_overloaded` | kolejka dostawcy pełna / dostawca przeciążony |
| 504 | `queue_timeout`, `upstream_timeout` | zbyt długie oczekiwanie |
| w strumieniu | `upstream_stream_interrupted` | dostawca urwał odpowiedź w trakcie |

Fallback po stronie aliasu następuje przy awariach dostawcy: `upstream_error`, `upstream_unreachable`, `upstream_overloaded`, `upstream_timeout`, `upstream_rate_limited`, `upstream_empty_response`, `upstream_invalid_response`, `upstream_auth_failed`, `upstream_stream_interrupted`, gdy dostawca nie zna modelu (`model_not_found` od dostawcy), `node_*`, `wol_failed`, `queue_full`, `queue_timeout` — i tylko zanim klient dostał pierwszą treść. Błędy samego żądania (`400`, `403`, `429` klucza) nigdy nie uruchamiają fallbacku.

---

## API administratora — `/admin/api`

`Authorization: Bearer $MINDGATE_ADMIN_TOKEN`. JSON w `snake_case`. Odpowiedzi mają `Cache-Control: no-store`. Klucze dostawców i klientów nigdy nie wracają: dostawca pokazuje `has_api_key` i ostatnie 4 znaki (`api_key_hint`), klient — prefiks.

| Metoda i ścieżka | Do czego |
|---|---|
| `GET /status` | wersja, czas pracy, stan dostawców i kolejek, liczniki |
| `GET /presets` | gotowe ustawienia dostawców (OpenRouter, Gemini, Anthropic, OpenAI, Ollama, LM Studio, własny, `mindgate-node` — maszyna z agentem MindGate) |
| `GET /providers`, `GET /providers/{id}` | lista / jeden dostawca |
| `POST /providers` | dodaj: `id`, `type` (`openai` / `anthropic`), `base_url`, `api_key`, `locality`, `auth_scheme` (`bearer` / `header` / `none`) + `auth_header`, `extra_headers`, `options`, `max_concurrency`, `node`, `enabled`. Od razu pobiera listę modeli (`"sync": false` to wyłącza) |
| `PATCH /providers/{id}` | zmień dowolne z pól; `api_key: null` usuwa klucz, brak pola go nie rusza |
| `DELETE /providers/{id}` | usuwa dostawcę z modelami; odpowiedź wymienia aliasy, które straciły cel (`aliases_affected`) |
| `POST /providers/{id}/test` | sprawdza połączenie bez zmian (`ok`, opóźnienie, liczba modeli) |
| `POST /providers/{id}/sync` | odświeża listę modeli |
| `POST /providers/{id}/wake` | budzi maszynę (dostawca z `node`) i czeka |
| `GET /providers/{id}/node` | maszyna: stan znany hubowi + to, co mówi jej agent (`agent`: model w pamięci, zadania w toku, CPU/RAM/GPU/dysk; `agent_error`, gdy agent nie odpowiada) |
| `GET /providers/{id}/node/models` | modele zainstalowane na maszynie (rozmiar, kwantyzacja, możliwości, `loaded`) razem z rekordem w hubie (`hub_id`, `hub`) |
| `POST /providers/{id}/node/pulls` | pobierz model: `{"name":"qwen3:4b"}` lub `hf.co/…`; `202` + zadanie z `id`. Gdy się skończy, model sam trafia do katalogu huba |
| `GET /providers/{id}/node/pulls`, `GET …/pulls/{pull}`, `DELETE …/pulls/{pull}` | zadania pobierania, postęp (`status`, `percent`, `completed`, `total`), przerwanie |
| `POST /providers/{id}/node/models/load`, `…/unload` | załaduj do karty (`name`, opcjonalnie `keep_alive`: `"30m"`, `-1`) / zwolnij |
| `DELETE /providers/{id}/node/models/{nazwa}` | usuń z dysku maszyny i z katalogu huba; odpowiedź wymienia aliasy, które straciły cel (`aliases_affected`) |
| `POST /providers/{id}/node/shutdown` | wyłącz maszynę; `{"force":true}` pomija sprawdzenia, które chronią przed wyłączeniem zajętego komputera |
| `GET /models[?provider=]` | modele z polami `reported` (co podał dostawca) i `overrides` (co ustawił właściciel) |
| `POST /models` | dodaj model ręcznie (`provider`, `id`, opcjonalnie `name`, `kind`, `context_length`, …) |
| `PATCH /models/{id}` | nadpisz `name`, `description`, `kind`, `tags`, `context_length`, `max_output_tokens`, `supports`, `locality`, `enabled`; `null` przywraca wartość od dostawcy |
| `DELETE /models/{id}` | model ręczny znika; zsynchronizowany zostaje wyłączony |
| `GET /aliases`, `POST /aliases`, `PATCH /aliases/{name}`, `DELETE /aliases/{name}` | aliasy: `name` (bez `/`), `targets` (kolejność = kolejność fallbacku, do 8), `description`, `tags`, `enabled` |
| `GET /keys`, `POST /keys` | klucze klientów; `POST` zwraca pełny klucz w polu `key` **jednorazowo** |
| `PATCH /keys/{id}`, `POST /keys/{id}/revoke`, `DELETE /keys/{id}` | zmiana limitów i ograniczeń, unieważnienie (historia zostaje), usunięcie |
| `GET /usage[?from=&to=&key=&model=]` | dzienne sumy (domyślnie 30 dni) |
| `GET /log[?limit=&before=&key=&errors=1]` | log żądań: bez treści rozmów |

`{id}` modelu zawiera `/` (np. `openrouter/deepseek/deepseek-chat`) i wstawia się go do ścieżki wprost.

### Ustawienia dostawcy (`options`)

| Opcja | Znaczenie |
|---|---|
| `first_byte_timeout_ms`, `idle_timeout_ms` | ile czekać na pierwszy bajt i na ciszę między fragmentami (zimny model lokalny potrafi ładować się minutami); maks. 1 h |
| `stream_usage` | czy prosić dostawcę o `stream_options.include_usage` (domyślnie tak; wyłącz dla serwerów, które to odrzucają) |
| `default_max_tokens` | Anthropic wymaga `max_tokens`; wartość, gdy klient jej nie poda |
| `models_path`, `chat_path`, `embeddings_path` | dla serwerów z innym układem niż OpenAI |
| `auto_enable_models` | nowe modele zaczynają włączone (domyślnie); wyłącz dla katalogów w setkach modeli |

### `node` (maszyna z usypianiem)

`mac`, `broadcast`, `port` (9), `min_wake_priority` (3), `boot_timeout_ms` (120000), `poll_interval_ms` (2000), `control_url` (adres agenta MindGate, np. `http://pc.lan:3001` — włącza zarządzanie modelami i domyślne `health_url` oraz `shutdown_url`), `health_url`, `shutdown_url`, `idle_shutdown_minutes` (wymaga `shutdown_url` albo `control_url`). Zob. [06 - Wake on LAN](06-wol.md) i [05 - Węzły](05-nodes.md).

Sekret agenta (`MINDGATE_NODE_SECRET`) to `api_key` dostawcy — szyfrowany jak każdy inny, nigdy nie wraca w odpowiedziach.
