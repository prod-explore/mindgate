# Agent — węzeł z modelami

Mały serwis na komputerze z GPU. Hub (patrz [01 - Hub](01-gate.md)) rozmawia z nim zamiast bezpośrednio z Ollamą i dzięki temu **wszystkim, co dotyczy modeli na tej maszynie, steruje się z huba**: co jest zainstalowane, pobranie nowego modelu, usunięcie, załadowanie do pamięci, wyłączenie komputera.

Agent robi cztery rzeczy:

1. **Pilnuje Ollamy.** Jeśli Ollama już działa — przejmuje ją; jeśli nie — uruchamia ją sam (i zamyka razem ze sobą). Jeśli padnie, następne żądanie uruchomi ją ponownie.
2. **Przepuszcza `/v1/*` do Ollamy** (API zgodne z OpenAI) — za sekretem, nic nie przepisując. Jedyny wyjątek: `GET /v1/models`, bo agent wie o modelu więcej niż Ollama mówi wprost (co model potrafi, jaki ma realny kontekst, tagi).
3. **Udostępnia hubowi API zarządzania** (`/node/*`): status maszyny, lista modeli, pobieranie w tle, usuwanie, ładowanie i zwalnianie z pamięci. Pełny opis: [05 - Protokół węzła](05-nodes.md).
4. **Wyłącza komputer** na prośbę huba po okresie bezczynności — ale tylko wtedy, gdy nic nie jest w toku i nikt nie używa PC (zob. [03 - Tray](03-tray.md)).

Czego agent **nie** robi (a stary agent robił): nie ma profili (`flash`, `reasoning`…), pipeline'ów, narzędzi MCP ani własnej kolejki. Nazwy dla klientów to **aliasy w hubie**, kolejkę prowadzi hub (`max_concurrency` dostawcy), a model wybierasz po prostu po nazwie z Ollamy. Dzięki temu agent jest tak prosty, że prawie nie ma co się w nim zepsuć.

---

## Wymagania

- Windows 10/11 albo Linux (Ubuntu 22.04+ / Debian 12+)
- Node.js 22+
- [Ollama](https://ollama.com) zainstalowana (agent może ją uruchamiać, ale nie instaluje)
- GPU z CUDA (opcjonalnie, ale bez niego dla większych modeli będzie wolno); `nvidia-smi` w PATH pozwala hubowi pokazać użycie pamięci karty

---

## Instalacja

```bash
cd mindgate/agent
npm install
npm run build

cp .env.example .env
# wygeneruj sekret i wpisz go do MINDGATE_NODE_SECRET:
openssl rand -hex 32
```

Ten sam sekret trafia potem w trzy miejsca: `agent/.env` (`MINDGATE_NODE_SECRET`), do huba (jako „API key” dostawcy) i do `tray/config/tray.yml` (`agent.secret`). Agent **nie wystartuje** z placeholderem z `.env.example` ani z sekretem krótszym niż 24 znaki.

Uruchomienie na próbę:

```bash
npm start
```

Sprawdzenie (zamień `SEKRET` i adres):

```bash
curl -H "Authorization: Bearer SEKRET" http://192.168.1.100:3001/health
# {"status":"ok","node_id":"MOJ-PC","runtime":"ok","in_flight":0,"downloads":0,"models_loaded":[],"uptime":12,...}

curl -H "Authorization: Bearer SEKRET" http://192.168.1.100:3001/node/status
```

---

## Konfiguracja (`agent/.env`)

Agent sam wczytuje plik `agent/.env` — niezależnie od tego, skąd został uruchomiony (usługa Windows nie startuje w jego folderze). Zmienne środowiskowe mają pierwszeństwo przed plikiem.

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `MINDGATE_NODE_SECRET` | — (wymagane) | wspólny sekret: `Authorization: Bearer …` |
| `MINDGATE_NODE_ID` | nazwa komputera | jak maszyna nazywa się w panelu i w `/node/status` |
| `MINDGATE_NODE_HOST` / `MINDGATE_NODE_PORT` | `0.0.0.0` / `3001` | gdzie agent słucha |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | adres Ollamy |
| `MINDGATE_MANAGE_OLLAMA` | `true` dla adresu lokalnego | czy agent może uruchomić Ollamę, gdy nie działa |
| `OLLAMA_PATH` | szukane automatycznie | pełna ścieżka do `ollama` / `ollama.exe`, gdy automat nie znajdzie |
| `MINDGATE_OLLAMA_START_TIMEOUT_MS` | `30000` | ile czekać, aż uruchomiona Ollama zacznie odpowiadać |
| `MINDGATE_TRAY_URL` | `http://127.0.0.1:3002` | tray na tej maszynie; **puste = brak traya** (serwer bez ekranu) |
| `MINDGATE_SHUTDOWN_DELAY_SECONDS` | `30` | opóźnienie systemowego `shutdown` (Linux zaokrągla w górę do minut) |
| `LOG_LEVEL` | `info` | |

Ollama uruchomiona przez agenta dziedziczy jego środowisko (bez zmiennych `MINDGATE_*`), więc jej ustawienia możesz trzymać w tym samym `.env`. Dla karty 4 GB sensowne są:

```
OLLAMA_CONTEXT_LENGTH=8192      # większy kontekst = więcej pamięci na cache; model sam z siebie często pozwala na 32k+
OLLAMA_MAX_LOADED_MODELS=1      # jeden model naraz, reszta czeka na zwolnienie pamięci
OLLAMA_NUM_PARALLEL=1
OLLAMA_KEEP_ALIVE=5m            # po 5 minutach bez użycia model schodzi z karty
OLLAMA_MODELS=D:\ollama-models  # gdzie leżą pliki modeli (gdy dysk systemowy jest mały)
```

Gdy agent zna `OLLAMA_CONTEXT_LENGTH`, **zgłasza hubowi właśnie tyle** jako długość kontekstu modelu (a nie to, co model potrafi teoretycznie). Dzięki temu hub nie obiecuje klientom okna, którego Ollama i tak nie użyje.

### Ollama uruchomiona osobno

Jeśli Ollama działa już jako usługa systemowa (typowo na Linuksie po instalacji skryptem), agent ją po prostu przejmie i nigdy nie zamknie. Jeśli Ollama jest na **innym komputerze**, ustaw `OLLAMA_URL` na jej adres — wtedy agent niczego nie uruchamia (`MINDGATE_MANAGE_OLLAMA` jest wyłączone) i działa jako brama z sekretem. Pamiętaj, że sama Ollama nie ma uwierzytelniania: nie wystawiaj jej poza maszynę, agent jest od tego, żeby była za sekretem.

---

## Uruchamianie jako usługa

### Windows

W PowerShellu **jako administrator**:

```powershell
cd mindgate\agent
npm run install-service
```

Powstaje usługa „MindGate Agent” (start automatyczny). Usunięcie: `npm run uninstall-service`. Po aktualizacji kodu (`git pull`) wystarczy `npm install`, `npm run build` i restart usługi — robi to `Restart-MindGate-Simple.bat` w katalogu głównym repozytorium.

Windows Defender Firewall musi przepuszczać port `3001` z sieci lokalnej (tylko z adresu huba, jeśli możesz).

### Linux (systemd)

```bash
sudo cp mindgate-agent.service /etc/systemd/system/
sudo nano /etc/systemd/system/mindgate-agent.service    # User= i WorkingDirectory=
sudo systemctl daemon-reload
sudo systemctl enable --now mindgate-agent
journalctl -u mindgate-agent -f
```

Żeby agent mógł wyłączyć komputer bez hasła, daj mu jedną regułę sudo (`sudo visudo -f /etc/sudoers.d/mindgate`):

```
twoj-user ALL=(root) NOPASSWD: /usr/sbin/shutdown
```

(Jeśli agent działa jako `root`, nic nie trzeba — i tak wywoła `shutdown` bez `sudo`.)

---

## Dodanie maszyny do huba

Najprościej z panelu / API: preset **„A PC with a GPU (MindGate agent)”** (`GET /admin/api/presets`). Ręcznie:

```bash
curl -X POST http://localhost:3000/admin/api/providers \
  -H "Authorization: Bearer $MINDGATE_ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{
  "id": "pc",
  "name": "Mój PC",
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

`control_url` to jedyna rzecz, która mówi hubowi „tu jest agent”: od niej hub wyprowadza adres sprawdzania stanu (`/health`) i prośby o wyłączenie (`/node/power/shutdown-request`). Bez niej węzeł nadal działa (budzenie, żądania), ale nie da się zarządzać jego modelami z huba. Budzenie: [06 - Wake on LAN](06-wol.md).

Dalej wszystko dzieje się w hubie — pobranie modelu (`POST /admin/api/providers/pc/node/pulls {"name":"qwen3:4b"}`), lista, usuwanie, aliasy: [04 - Modele](04-models.md) i [08 - API](08-api.md).

---

## Wyłączanie komputera

Hub prosi o wyłączenie po `idle_shutdown_minutes` bez żądań. Agent odpowiada `{"allow": …, "reason": …}` i wyłącza komputer tylko wtedy, gdy **wszystkie** warunki są spełnione:

1. żadne żądanie nie jest w toku (`requests_in_flight`),
2. nic się nie pobiera (`download_in_progress`),
3. tray potwierdza, że nikt nie używa PC (zob. [03 - Tray](03-tray.md)) — jego „nie” jest ostateczne; gdy tray **nie odpowiada**, odpowiedź brzmi `tray_unreachable`, bo komputera, przy którym ktoś może siedzieć, nie wyłącza się na zgadywanie.

Bez traya (`MINDGATE_TRAY_URL=` puste, serwer bez ekranu) liczą się tylko warunki 1 i 2.

Po „nie” hub czeka 5 minut, zanim zapyta ponownie. Człowiek może wyłączyć maszynę z huba wprost (`POST …/node/shutdown` z `"force": true`) — to jego decyzja, więc pomija warunki 1–3.

---

## Bezpieczeństwo

- Każde wywołanie agenta (także `/health`) wymaga sekretu; porównanie jest odporne na pomiar czasu, a żądanie bez sekretu nie dociera do Ollamy.
- Sekret nie jest przekazywany dalej do Ollamy ani do jej procesu potomnego.
- Agent słucha na `0.0.0.0`, bo hub jest na innym komputerze. Jeśli maszynę widzi tylko LAN, to wystarczy; w przeciwnym razie ogranicz port 3001 zaporą do adresu huba albo ustaw `MINDGATE_NODE_HOST` na jeden interfejs.
- Ruch między hubem a agentem jest zwykłym HTTP. Dla sieci domowej to zwykle akceptowalne; poza nią — WireGuard / Tailscale pod spodem.
- Dostęp do `/node/*` oznacza możliwość pobrania dowolnego modelu na dysk i wyłączenia komputera. Dlatego jest tylko jeden sekret i tylko dla huba (i traya).

---

## Migracja ze starego agenta

| Było | Jest |
|---|---|
| `config/models.yml` (profile, pipelines, `server.secret`) | nie ma; sekret → `MINDGATE_NODE_SECRET` w `agent/.env`, profile → aliasy w hubie |
| `config/mcp.yml`, narzędzia MCP | usunięte |
| nagłówek `X-MindGate-Secret` | `Authorization: Bearer …` (stary nagłówek agent jeszcze przyjmuje, ale hub i tray używają nowego) |
| `/internal/shutdown-request`, `/internal/set-user-active`, `/internal/exit` | `/node/power/shutdown-request`, `/node/user-active`, `/node/exit` |
| `node src/index.js` | `npm run build`, potem `node dist/index.js` (usługa: `npm run install-service`) |

Kroki: `git pull`, w `agent/` `npm install && npm run build`, utwórz `.env`, usuń stary `config/`, zainstaluj ponownie usługę (`uninstall-service`, potem `install-service`), zaktualizuj tray (ta sama paczka). W hubie: `import-legacy` przenosi dostawcę i klucze (zob. [01 - Hub](01-gate.md)). Pobrane modele zostają — Ollama je trzyma.

---

## Rozwiązywanie problemów

**Agent kończy się od razu z „MINDGATE_NODE_SECRET is not set / too weak”** — sekret w `agent/.env` brakuje albo jest placeholderem. `openssl rand -hex 32`.

**Hub pokazuje `node_auth_failed`** — sekret w hubie (pole „API key” dostawcy) różni się od `MINDGATE_NODE_SECRET`.

**Hub pokazuje `agent_missing`** — pod `control_url` nie odpowiada agent MindGate (stary agent, zły port, zły prefiks). `curl -H "Authorization: Bearer …" <control_url>/node/status` pokaże, co tam jest.

**`runtime_unavailable` / „Ollama is not installed here”** — agent nie znalazł `ollama`. Zainstaluj ją albo ustaw `OLLAMA_PATH`.

**Pierwsze żądanie po starcie trwa minutę** — model ładuje się z dysku do karty. Dlatego dostawca z presetu ma `first_byte_timeout_ms` 10 minut. Można załadować go z góry (`…/node/models/load`).

**Model nie mieści się na karcie** — Ollama przeniesie część warstw do RAM i będzie wolniej, nie przestanie działać. Zob. [04 - Modele](04-models.md), jak dobrać rozmiar.
