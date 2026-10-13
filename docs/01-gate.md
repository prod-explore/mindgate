# Hub (gate) — Raspberry Pi

Hub to jedyny punkt wejścia do MindGate: jedno API zgodne z OpenAI, za którym stoją **dostawcy** — lokalna maszyna z GPU (budzona Wake-on-LAN), OpenRouter, Gemini, Anthropic, Ollama, cokolwiek co mówi po HTTP. Klient zna jeden adres i jeden klucz; hub decyduje dokąd to pójdzie, pilnuje limitów i niczego nie zapisuje poza liczbami.

Działa na Raspberry Pi 4+ (ARM64, 2 GB RAM wystarczy) albo na dowolnym Linuxie z Dockerem lub Node 22.

---

## Instalacja (Docker)

```bash
git clone https://github.com/prod-explore/mindgate.git
cd mindgate/gate

cp .env.example .env
# wstaw dwa różne sekrety (każdy: openssl rand -hex 32) do MINDGATE_MASTER_KEY i MINDGATE_ADMIN_TOKEN
nano .env

docker network create mindgate_net      # wspólna sieć z nginx; pomiń, jeśli usuniesz ją z docker-compose.yml
docker compose up -d --build
docker compose logs -f gate
```

Hub **nie wystartuje** z placeholderami z `.env.example` ani z krótkim lub powtarzalnym sekretem — to celowe.

- `MINDGATE_MASTER_KEY` szyfruje klucze API dostawców zapisane w bazie (AES-256-GCM). **Zachowaj kopię osobno od backupów bazy**: bez niego zapisanych kluczy dostawców nie da się odczytać i trzeba je wpisać od nowa.
- `MINDGATE_ADMIN_TOKEN` chroni `/admin`. Inny niż master key.

### Bez Dockera

```bash
cd mindgate/gate
npm ci
npm run build
npm start          # czyta .env z bieżącego katalogu (Node >= 22.9)
```

---

## Pierwsze kroki

Wszystko poniżej to wywołania API administratora (`/admin/api`, nagłówek `Authorization: Bearer $MINDGATE_ADMIN_TOKEN`). Pełna lista: [08 - API](08-api.md).

```bash
HUB=http://localhost:3000
ADMIN="Authorization: Bearer <MINDGATE_ADMIN_TOKEN>"

# 1. Dostawca. Gotowe ustawienia: GET /admin/api/presets
curl -X POST $HUB/admin/api/providers -H "$ADMIN" -H 'Content-Type: application/json' -d '{
  "id": "openrouter", "type": "openai", "base_url": "https://openrouter.ai/api/v1",
  "api_key": "sk-or-...", "locality": "cloud",
  "options": { "auto_enable_models": false }
}'
# hub od razu pobiera listę modeli; OpenRouter ma ich setki, więc są wyłączone dopóki ich nie włączysz:
curl -X PATCH $HUB/admin/api/models/openrouter/deepseek/deepseek-chat -H "$ADMIN" -H 'Content-Type: application/json' -d '{"enabled": true}'

# 2. Alias z jawnym fallbackiem: najpierw tańszy model, a gdy zawiedzie — drugi
curl -X PATCH $HUB/admin/api/models/openrouter/google/gemini-2.5-flash -H "$ADMIN" -H 'Content-Type: application/json' -d '{"enabled": true}'
curl -X POST $HUB/admin/api/aliases -H "$ADMIN" -H 'Content-Type: application/json' -d '{
  "name": "smart", "targets": ["openrouter/deepseek/deepseek-chat", "openrouter/google/gemini-2.5-flash"]
}'

# 3. Klucz dla klienta (pełny klucz pokazany jest TYLKO TERAZ)
docker compose exec gate node dist/cli.js keys create laptop --rpm 30 --tokens-day 500000
```

W kliencie: adres `http://<ip-huba>:3000/v1`, klucz `mg-…`, model `smart` albo `openrouter/deepseek/deepseek-chat`.

---

## Jak hub obsługuje żądanie

```
klucz → model/alias → limity → [dla każdego celu po kolei:] obudź maszynę → czekaj na wolny slot → dostawca → odpowiedź
```

1. **Klucz.** Przechowywany jest tylko skrót (SHA-256); klient pokazuje `mg-…`, hub porównuje skróty.
2. **Model.** `dostawca/model` (np. `openrouter/deepseek/deepseek-chat`) to model konkretnego dostawcy. Nazwa bez `/` to alias. Nic innego nie jest zgadywane.
3. **Limity klucza** — zob. niżej. Odrzucone żądanie nie dociera do modelu i nic nie kosztuje.
4. **Cel.** Jeśli dostawca to maszyna z usypianiem — hub ją budzi i czeka. Jeśli dostawca obsługuje jedno żądanie naraz — żądanie czeka w kolejce według priorytetu.
5. **Odpowiedź** wraca w formacie OpenAI (także z Anthropic — hub tłumaczy narzędzia, obrazy, myślenie i strumień). Nagłówki `X-MindGate-Model` i `X-MindGate-Provider` mówią, kto odpowiedział; w treści jest też obiekt `mindgate` z listą prób.

### Aliasy i fallback — bez cichych podmian

- Model podany wprost (`dostawca/model`) **nigdy** nie przechodzi na inny. Błąd dostawcy to błąd dla klienta.
- Alias ma uporządkowaną listę celów. Gdy pierwszy zawiedzie *zanim klient zobaczył choć bajt odpowiedzi*, hub bierze następny — i mówi o tym: nagłówek `X-MindGate-Fallback: <model, który zawiódł>`, a w `mindgate.attempts` pełna historia.
- Fallback dotyczy awarii dostawcy: 5xx, limit u dostawcy, timeout, brak połączenia, uśpiona lub niedostępna maszyna, pełna kolejka. **Nie** dotyczy błędów żądania (np. za długi kontekst): to samo żądanie zawiodłoby wszędzie, a podmiana ukryłaby problem.
- Gdy odpowiedź już płynie i dostawca się urwie, strumień kończy się zdarzeniem błędu — hub nie dokańcza cudzej wypowiedzi innym modelem.

### Tryb tylko-lokalny

Prywatne dane nie mogą trafić do chmury, więc `local_only` działa na całą ścieżkę, także fallbacki:

- na kluczu: `keys create nazwa --local-only` (klient go nie wyłączy),
- na żądaniu: nagłówek `X-MindGate-Local-Only: true`.

Model jest lokalny, jeśli dostawca jest oznaczony `locality: local` (Ollama, maszyna z GPU) — a właściciel może to nadpisać na pojedynczym modelu. Cel w chmurze jest pomijany *bez wysyłania do niego czegokolwiek*; alias bez żadnego celu lokalnego daje `403 local_only_violation`. `/v1/models` pokazuje takiemu wywołaniu tylko to, co jest dla niego osiągalne.

### Klucze klientów i limity

Każdy klient ma własny klucz z ustawieniami:

| Ustawienie | Znaczenie |
|---|---|
| `rpm` | żądań na minutę → `429 rate_limited` + `Retry-After` |
| `rpd` | żądań na dobę → `429 budget_exhausted` + `reset_at` |
| `tokens_per_day`, `tokens_per_month` | budżet tokenów (wejście + wyjście) → `429 budget_exhausted` + `reset_at` |
| `min_/default_/max_priority` | zakres priorytetu 1–5, jaki klient może zażądać |
| `local_only` | patrz wyżej |
| `allowed_models` | lista: `smart`, `home/*`, `openrouter/deepseek/deepseek-chat`; `null` = wszystko |

„Doba” i „miesiąc” zaczynają się o północy w strefie `MINDGATE_USAGE_TZ` (np. `Europe/Warsaw`), także w dniach zmiany czasu. Klient sprawdza swoje zużycie pod `GET /v1/usage`.

Budżet tokenów liczy zakończone żądania; żądania, które jeszcze trwają, mogą go lekko przekroczyć — odmowa następuje przy kolejnym. `rpm` jest trzymane w pamięci (restart hubu wypuszcza najwyżej jeden zryw).

### Priorytety i kolejka

`X-MindGate-Priority: 1–5` (domyślnie z klucza, obcięte do zakresu klucza). Dostawca z `max_concurrency` (np. 1 dla jednego GPU) ma kolejkę: 5 przed 1, w obrębie priorytetu kto pierwszy. Kolejka ma limit (`MINDGATE_QUEUE_MAX`) i opcjonalny czas oczekiwania (`MINDGATE_QUEUE_TIMEOUT_MS`); klient, który się rozłączy, wypada z kolejki i nie zajmuje miejsca.

### Maszyna, która śpi (Wake-on-LAN)

Dostawca z ustawionym `node` to komputer, który hub budzi:

- żądanie z priorytetem `>= min_wake_priority` (domyślnie 3) wysyła magic packet i czeka (do `boot_timeout_ms`), a przy streamingu, gdy robi się cicho, wysyła komentarze SSE (`MINDGATE_KEEPALIVE_*`), żeby nginx i klient nie zerwali połączenia;
- żądanie z niższym priorytetem **nie budzi** maszyny: dostaje `503 node_asleep` — a jeśli to alias, hub od razu bierze następny cel (np. chmurę);
- wiele żądań czekających na tę samą maszynę to jedno budzenie;
- po `idle_shutdown_minutes` bez żądań hub prosi agenta o wyłączenie (`POST <control_url>/node/power/shutdown-request`, albo własny `shutdown_url`); agent decyduje, czy faktycznie (trwa żądanie lub pobieranie, ktoś pracuje przy komputerze). Odmowa lub błąd to 5 minut przerwy, zanim hub zapyta ponownie;
- gdy maszyna zniknie w trakcie (zasilanie), hub sprawdza ją na nowo, w razie potrzeby budzi i ponawia **raz**; potem `502 node_connection_lost`.

Z `node.control_url` (adres agenta MindGate, np. `http://pc.lan:3001`) hub zarządza też **modelami na maszynie**: pobiera je, usuwa, ładuje do karty i pokazuje stan sprzętu — [05 - Węzły](05-nodes.md), [04 - Modele](04-models.md). Hub **nie budzi** maszyny, żeby coś takiego zrobić; jeśli śpi, dostajesz jasny błąd.

Konfiguracja WoL po stronie komputera i routera: [06 - Wake on LAN](06-wol.md).

### Co hub zapisuje

W logu żądań: kiedy, który klucz, jaki model i dostawca, kod odpowiedzi, czasy (kolejka, pierwszy bajt, całość), liczba tokenów, kolejne próby fallbacku. **Nigdy treści rozmowy** — ani pytania, ani odpowiedzi. Log jest czyszczony po `MINDGATE_LOG_RETENTION_DAYS` (30). Dzienne sumy do limitów zostają.

---

## Migracja ze starego gate'a

Stary `config.yml` (agent, WoL, klucze) przenosi jedno polecenie:

```bash
docker compose exec -T gate sh -c 'cat > /tmp/config.yml' < config/config.yml
docker compose exec gate node dist/cli.js import-legacy /tmp/config.yml --dry-run   # co by się stało
docker compose exec gate node dist/cli.js import-legacy /tmp/config.yml
```

Powstaje:

- dostawca `agent` — lokalny, jedno żądanie naraz, z budzeniem WoL, wyłączaniem po bezczynności i `control_url` wskazującym na nowego agenta. Dawny sekret z `config.yml` staje się jego kluczem, więc **wpisz go w `agent/.env` jako `MINDGATE_NODE_SECRET`** (co najmniej 24 znaki, bez słów w rodzaju „change-me”; ze słabszym agent nie wystartuje — wtedy wymyśl nowy i wpisz go też w hubie: `PATCH /admin/api/providers/agent` z `api_key`);
- **modele nie są kopiowane** — hub pozna je z maszyny po uruchomieniu nowego agenta (`POST /admin/api/providers/agent/sync` albo samo po starcie). Dawne nazwy profili (`flash`, `reasoning`…) nie są przenoszone. Chcesz, żeby klienci dalej ich używali: podaj `--agent-models <ścieżka>` do swojego starego `models.yml` agenta (na komputerze z GPU, w `agent/config/`; zrób jego kopię przed aktualizacją, nowy agent już go nie czyta), a każdy profil stanie się **aliasem** na prawdziwy model Ollamy, który oznaczał. Albo utwórz aliasy sam w panelu;
- klucze klientów z tymi samymi wartościami i priorytetami (placeholdery z przykładu są pomijane). Teraz są skrótami: plik `config.yml` możesz usunąć.

Czego już nie ma: **pipeline'ów** i **narzędzi MCP** wstrzykiwanych przez agenta — hub zwraca to, co mówi model, a łączenie modeli w ciąg to sprawa klienta. Alias z kilkoma celami to lista fallbacku, nie sekwencja. Import wypisze, które pipeline'y miałeś.

Zmienia się też: kolejka i port to teraz zmienne środowiskowe (import wypisze które), a pojedyncze żądanie czeka najwyżej godzinę (stary gate nie miał limitu). Agent wymaga aktualizacji do wersji 2 — [02 - Agent](02-agent.md).

---

## Backup

```bash
docker compose exec gate node dist/cli.js backup --keep 7
```

Spójna kopia (także przy działającym hubie) trafia do `/data/backups`, zweryfikowana. Klucze dostawców w niej są zaszyfrowane `MINDGATE_MASTER_KEY` — kopię bazy i master key trzymaj osobno. `node dist/cli.js check [--online]` sprawdza konfigurację, bazę i (opcjonalnie) łączność z dostawcami.

---

## Reverse proxy (nginx)

Hub słucha na 3000 w sieci Dockera. Przy proxy ustaw `MINDGATE_TRUST_PROXY=true`, żeby limit prób logowania liczył prawdziwy adres klienta.

```nginx
server {
    listen 443 ssl;
    server_name raspi.twojadomena.pl;

    ssl_certificate     /etc/letsencrypt/live/raspi.twojadomena.pl/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/raspi.twojadomena.pl/privkey.pem;

    client_max_body_size 25m;

    location / {
        proxy_pass http://mindgate-gate:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;          # strumień SSE ma płynąć na bieżąco
        proxy_read_timeout 3600s;     # długie odpowiedzi dużych modeli
        proxy_send_timeout 3600s;
    }
}
```

`/admin` ma własny token, ale nie ma powodu wystawiać go do internetu: w nginx możesz je ograniczyć do sieci lokalnej (`location /admin { allow 192.168.0.0/16; deny all; … }`).

---

## Zmienne środowiskowe

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `MINDGATE_MASTER_KEY` | — (wymagana) | szyfruje klucze dostawców w bazie |
| `MINDGATE_ADMIN_TOKEN` | — (wymagana) | token `/admin`, inny niż master key |
| `MINDGATE_DB` | `./data/mindgate.db` (`/data/mindgate.db` w Dockerze) | plik SQLite (tryb 600) |
| `MINDGATE_HOST`, `MINDGATE_PORT` | `0.0.0.0`, `3000` | gdzie słucha |
| `MINDGATE_USAGE_TZ` | `UTC` | strefa, w której zaczyna się doba/miesiąc dla limitów |
| `MINDGATE_TRUST_PROXY` | `false` | ufaj `X-Forwarded-For` |
| `MINDGATE_BODY_LIMIT_MB` | `20` | maks. rozmiar żądania |
| `MINDGATE_QUEUE_MAX`, `MINDGATE_QUEUE_TIMEOUT_MS` | `100`, `0` | kolejka dostawcy z `max_concurrency` (0 = bez limitu czasu) |
| `MINDGATE_LOG_RETENTION_DAYS` | `30` | jak długo trzymać log żądań |
| `MINDGATE_LOG_LEVEL` | `info` | poziom logów procesu |
| `MINDGATE_KEEPALIVE_AFTER_MS`, `…_INTERVAL_MS` | `10000` | komentarze SSE przy długim oczekiwaniu |
| `MINDGATE_FIRST_BYTE_TIMEOUT_MS`, `MINDGATE_IDLE_TIMEOUT_MS` | `300000`, `120000` | domyślne limity czasu dostawcy (nadpisywalne per dostawca) |
| `MINDGATE_SYNC_INTERVAL_HOURS` | `24` | jak często odświeżać listy modeli |
| `MINDGATE_ALLOW_WEAK_SECRETS` | `false` | tylko do lokalnych testów: słaby sekret to ostrzeżenie |

---

## Struktura kodu

```
gate/src/
├── index.ts, server.ts       start procesu, serwer Fastify, obsługa błędów
├── routes-v1.ts              /v1/models, /v1/chat/completions, /v1/embeddings, /v1/usage
├── routes-admin.ts           /admin/api/* (dostawcy, modele, aliasy, klucze, zużycie, log)
├── chat.ts                   jedno żądanie od klucza do ostatniego bajtu (fallback, SSE, rozliczenie)
├── routing.ts                nazwa → lista celów; local_only, allowed_models
├── limits.ts, queue.ts       limity kluczy, kolejka priorytetowa
├── node.ts                   Wake-on-LAN, stan maszyny, wyłączanie po bezczynności
├── adapters/                 openai (przezroczysty), anthropic (tłumaczenie tam i z powrotem)
├── store/                    dostawcy, modele, aliasy, klucze, zużycie (SQLite)
├── crypto.ts, db.ts, …       szyfrowanie sekretów, migracje bazy
└── cli.ts                    keys, import-legacy, backup, check
```

---

## Troubleshooting

**Hub nie startuje: „MINDGATE_MASTER_KEY is too weak”** — wstaw prawdziwy sekret (`openssl rand -hex 32`); placeholder z `.env.example` jest odrzucany.

**`provider_secret_unreadable`** — zmieniono `MINDGATE_MASTER_KEY`. Przywróć stary albo wpisz klucz dostawcy od nowa (`PATCH /admin/api/providers/<id>` z `api_key`). `node dist/cli.js check` pokazuje, których dostawców to dotyczy.

**`node_asleep` mimo że chcę obudzić maszynę** — priorytet żądania jest niższy niż `min_wake_priority`. Wyślij `X-MindGate-Priority: 3` lub więcej, albo obudź ją ręcznie: `POST /admin/api/providers/<id>/wake`.

**WoL nie działa** — [06 - Wake on LAN](06-wol.md). Najczęściej: WoL wyłączony w BIOS albo Fast Startup w Windows. Gdy hub działa w mostku Dockera, wpisz w `broadcast` adres IP maszyny (unicast) zamiast adresu broadcast sieci.

**`429 budget_exhausted`** — klient wyczerpał limit swojego klucza; `GET /v1/usage` mówi, ile zużył i kiedy wraca (`reset_at`).

**401** — nagłówek to `Authorization: Bearer mg-…` (ze spacją po „Bearer”); po 20 błędnych próbach adres jest blokowany na minutę.
