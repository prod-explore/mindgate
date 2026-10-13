# Protokół węzła

Ten dokument opisuje, co hub robi z maszyną z GPU i czego do tego oczekuje. Agent MindGate (`/agent`) to jedna implementacja tego protokołu; kto napisze drugą (inny silnik niż Ollama, inny system), może ją podłączyć do huba bez zmian po jego stronie.

Węzeł to dostawca (provider) z ustawieniem `node`. Hub widzi go na trzech poziomach:

| Poziom | Czego potrzebuje | Co daje |
|---|---|---|
| **Dostawca** | serwer zgodny z OpenAI pod `base_url` | żądania, lista modeli (`GET /v1/models`) |
| **Maszyna** | `node.mac`, `node.broadcast` | budzenie Wake-on-LAN, wykrywanie czy śpi |
| **Agent** | `node.control_url` + protokół poniżej | status sprzętu, pobieranie/usuwanie/ładowanie modeli, wyłączanie |

Każdy kolejny poziom jest opcjonalny. Sam „dostawca” to np. czysta Ollama w sieci.

## Uwierzytelnianie

Wszystko — także `/health` — wymaga `Authorization: Bearer <sekret>`. Sekret jest „API key” dostawcy w hubie. Agent przyjmuje też stary nagłówek `X-MindGate-Secret`. Brak lub zły sekret: `401`

```json
{ "error": { "message": "Unauthorized: …", "type": "authentication_error", "code": "invalid_node_secret" } }
```

Hub zamienia to na `502 node_auth_failed` (to jego konfiguracja jest zła, nie klienta).

## Błędy

Każdy błąd agenta ma kształt `{ "error": { "message", "type", "code" } }`. Kody, które hub rozpoznaje:

| Kod | HTTP | Znaczenie |
|---|---|---|
| `invalid_node_secret` | 401 | zły sekret |
| `invalid_model_name` | 400 | nazwa spoza `[A-Za-z0-9._\-:/@+]`, pusta albo dłuższa niż 200 znaków |
| `invalid_request` | 400 | brak pola, zły typ |
| `model_not_found` | 404 | takiego modelu nie ma na maszynie |
| `pull_not_found` | 404 | takiego pobierania nie ma |
| `runtime_unavailable` | 503 | silnik modeli (Ollama) nie odpowiada i nie da się go uruchomić |
| `runtime_error` | 400/502 | silnik odrzucił polecenie; `message` zawiera jego powód |
| `unknown_endpoint` | 404 | to nie jest (ten) agent |

## Stan

### `GET /health`

Lekki stan dla huba i traya (hub odpytuje to co 30 s, gdy węzeł ma `control_url`).

```json
{
  "status": "ok",              // "ok" | "degraded" (silnik nie odpowiada)
  "node_id": "MOJ-PC",
  "version": "2.0.0",
  "runtime": "ok",             // "ok" | "unreachable"
  "in_flight": 0,              // żądania /v1 w toku
  "downloads": 0,              // pobierania w toku lub w kolejce
  "models_loaded": ["qwen3:4b"],
  "uptime": 3600
}
```

### `GET /node/status`

Pełny obraz maszyny.

```json
{
  "node_id": "MOJ-PC", "version": "2.0.0", "platform": "win32", "hostname": "MOJ-PC", "uptime_seconds": 3600,
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

`runtime.ok: false` nie jest błędem HTTP: status ma się dać obejrzeć właśnie wtedy, gdy coś nie działa. `gpus` jest puste bez `nvidia-smi`; `disk` pokazuje wolne miejsce tam, gdzie leżą modele (przed pierwszym pobraniem — w najbliższym istniejącym folderze nadrzędnym).

## API zgodne z OpenAI: `/v1/*`

Agent przekazuje `GET|POST /v1/*` do silnika bez zmian (ciało żądania bajt w bajt, strumień SSE bez buforowania). Gdy klient (hub) się rozłączy, agent przerywa żądanie do silnika, więc nic nie generuje się „w próżnię”. Jeśli silnik nie działa, agent próbuje go uruchomić, a gdy się nie uda, odpowiada `503 runtime_unavailable` (hub traktuje to jako błąd dostawcy, po którym alias może przejść do następnego celu).

Jedyny wyjątek to **`GET /v1/models`**. Agent odpowiada sam, formatem OpenAI rozszerzonym o pola, które hub rozumie bez specjalnego kodu dla agenta:

```json
{
  "object": "list",
  "data": [{
    "id": "qwen3:4b", "object": "model", "created": 1790000000, "owned_by": "ollama",
    "kind": "chat",                                     // "chat" | "embedding"
    "locality": "local",
    "tags": [],                                         // "uncensored" dla nazw z „abliterated” / „uncensored”
    "context_length": 8192,                             // min(model, OLLAMA_CONTEXT_LENGTH)
    "supported_parameters": ["tools", "reasoning"],     // z możliwości zgłaszanych przez silnik
    "architecture": { "input_modalities": ["text"], "output_modalities": ["text"] }
  }]
}
```

Pola `supported_parameters` i `architecture` są pomijane, gdy silnik nie zgłasza możliwości (stara Ollama): „nie wiem” to nie „nie potrafi”. Hub przy synchronizacji zapisuje to, co przyszło; ręczne poprawki właściciela (nazwa, tagi, kontekst) mają pierwszeństwo i przeżywają kolejne synchronizacje.

## Modele

### `GET /node/models`

Bogatsza lista niż `/v1/models` — dla panelu.

```json
{ "object": "list", "data": [{
  "id": "qwen3:4b", "kind": "chat", "size_bytes": 2600000000, "digest": "sha256:…", "modified_at": "…",
  "family": "qwen3", "parameter_size": "4.0B", "quantization": "Q4_K_M", "context_length": 40960,
  "capabilities": ["completion", "tools", "thinking"], "tags": [],
  "loaded": { "vram_bytes": 2700000000, "size_bytes": 3100000000, "expires_at": "…" }   // null, gdy nie w pamięci
}] }
```

### Pobieranie (w tle)

Pobranie modelu trwa minuty, więc jest zadaniem: startujesz je, potem oglądasz postęp. Naraz idzie jedno; kolejne czekają (`queued`). Ponowna prośba o model, który już się pobiera, zwraca to samo zadanie.

| Wywołanie | Efekt |
|---|---|
| `POST /node/pulls {"name": "qwen3:4b"}` | `202` i zadanie |
| `GET /node/pulls` | lista, najnowsze pierwsze (ostatnie 50 zakończonych) |
| `GET /node/pulls/:id` | jedno zadanie |
| `DELETE /node/pulls/:id` | przerywa trwające (silnik dostaje zerwane połączenie); zakończone usuwa z listy |

```json
{ "id": "…", "name": "qwen3:4b", "status": "running", "phase": "pulling 6e4c38e1172f",
  "completed": 1300000000, "total": 2600000000, "percent": 50, "error": null,
  "created_at": "…", "started_at": "…", "finished_at": null }
```

`status`: `queued` → `running` → `succeeded` | `failed` | `cancelled`. `total` rośnie, gdy silnik zgłasza kolejne warstwy, więc procent bywa na początku niedokładny. `error` ma powód z silnika (np. „pull model manifest: file does not exist”).

Nazwa to to, co przyjmuje silnik: `qwen3:4b`, `hf.co/użytkownik/repo:Q4_K_M`, `registry.ollama.ai/library/…`.

### Usuwanie, ładowanie

| Wywołanie | Efekt |
|---|---|
| `DELETE /node/models/<nazwa>` | usuwa z dysku (nazwa w ścieżce, `/` zostają, `:` może być kodowane jako `%3A`) |
| `POST /node/models/load {"name", "keep_alive"?}` | ładuje do pamięci przed pierwszym żądaniem; `keep_alive` jak w Ollamie (`"10m"`, `-1` = do zwolnienia) |
| `POST /node/models/unload {"name"}` | zwalnia pamięć karty |

Modele embeddingowe są ładowane i zwalniane przez `/api/embed`, bo nie potrafią „generować”.

## Zasilanie

### `POST /node/power/shutdown-request {"idle_minutes": 15}`

Tak pyta hub po okresie bezczynności. Odpowiedź zawsze `200` z `{ "allow": bool, "reason": string }`; hub uznaje wyłączenie tylko przy `allow: true`.

| `reason` | `allow` | Znaczenie |
|---|---|---|
| `shutdown_initiated` | true | polecenie systemowe poszło; komputer wyłączy się za `MINDGATE_SHUTDOWN_DELAY_SECONDS` |
| `shutdown_in_progress` | true | już się wyłącza |
| `requests_in_flight` | false | trwa żądanie |
| `download_in_progress` | false | trwa pobieranie |
| `user_active` | false | (bez traya) ktoś zgłosił, że używa PC |
| *powód traya* (np. `user_toggle_active`, `user_recently_active`) | false | tray odmówił |
| `tray_unreachable` | false | tray miał odpowiedzieć i nie odpowiedział |
| `shutdown_failed` | false | system odmówił wykonania polecenia (Linux: brak reguły sudo) |

### `POST /node/power/shutdown {"force": false}`

Jak wyżej, ale z decyzji człowieka. `force: true` pomija sprawdzenia (odpowiedź `reason: "forced"`).

### `POST /node/user-active {"active": true, "last_input_seconds_ago": 12}`

Tray zgłasza, czy ktoś siedzi przy komputerze (widać to w `/node/status`).

### `POST /node/exit`

Tray prosi agenta, by zakończył działanie (agent odpowiada, po pół sekundy zamyka silnik, który sam uruchomił, i kończy; jako usługa Windows zatrzymuje także usługę).

## Co hub robi z węzłem

- **Sprawdza stan**: `GET <control_url>/health` (domyślnie; `node.health_url` to nadpisuje) przy żądaniu, gdy ostatnia odpowiedź jest starsza niż 30 s, i co 30 s w tle. Jakakolwiek odpowiedź poniżej 500 znaczy „maszyna działa”.
- **Budzi** (Wake-on-LAN) tylko wtedy, gdy żądanie klienta tego wymaga i ma odpowiedni priorytet. Zarządzanie modelami z panelu **nigdy** nie budzi maszyny — człowiek ma zobaczyć, że śpi, i sam zdecydować (przycisk „Obudź”).
- **Synchronizuje listę modeli** z `GET /v1/models` agenta: po starcie, co `MINDGATE_SYNC_INTERVAL_HOURS`, na żądanie, po zakończeniu pobierania, po usunięciu modelu.
- **Obserwuje pobieranie, które sam zlecił** (co 2 s), żeby gotowy model pojawił się w katalogu, nawet gdy nikt nie ma otwartego panelu. Pobrania zlecone inaczej (np. z linii poleceń na maszynie) zostaną dopisane przy najbliższym spojrzeniu na listę zadań albo przy zwykłej synchronizacji.
- **Pyta o wyłączenie** po `node.idle_shutdown_minutes` bez żądań przez hub: `POST <control_url>/node/power/shutdown-request`. „Nie” oznacza: zapytaj ponownie nie wcześniej niż za 5 minut. Odpowiedź bez pola `allow` (własny skrypt zwracający samo `200`) hub traktuje jak „tak”.

## Własny agent

Minimum, żeby maszyna była użytecznym dostawcą: serwer OpenAI-compatible pod `base_url` z `GET /models` (bez żadnego agenta). Do zarządzania z huba dochodzi: `GET /health`, `GET /node/status`, `GET|POST|DELETE /node/pulls…`, `GET /node/models`, `DELETE /node/models/*`, `POST /node/models/load|unload`, `POST /node/power/shutdown-request` i `shutdown` — dokładnie w kształtach powyżej. Atrapa agenta, na której hub jest testowany, to `startFakeAgent` w `gate/src/__tests__/helpers.ts`; wzorzec rzeczywistej implementacji to `agent/src/routes-node.ts`. Silnik inny niż Ollama to jedna klasa implementująca interfejs `Runtime` (`agent/src/runtime.ts`).
