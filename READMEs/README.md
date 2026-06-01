# MindGate

Lokalny, prywatny system AI na własnym sprzęcie. Raspberry Pi pełni rolę bramy (gate) — przyjmuje żądania z zewnątrz, autoryzuje je, zarządza priorytetami i budzi maszynę obliczeniową gdy trzeba. Maszyna obliczeniowa uruchamia lokalne modele LLM przez Ollama i obsługuje narzędzia MCP.

Całość wystawia **OpenAI-compatible API** — działa bezpośrednio z AntyGraviti, Cursor, Open WebUI, Continue.dev i każdym innym narzędziem które umie gadać z `/v1/chat/completions`.

---

## Architektura

```
Klient (IDE / przeglądarka / skrypt)
        │
        │ HTTPS  /v1/chat/completions
        ▼
┌─────────────────────────────────┐
│         Raspberry Pi            │
│                                 │
│  ┌─────────────────────────┐    │
│  │   Reverse Proxy         │    │
│  │   (nginx / Caddy + TLS) │    │
│  └──────────┬──────────────┘    │
│             │                   │
│  ┌──────────▼──────────────┐    │
│  │   mindgate-gate         │    │
│  │   (Node.js + Fastify)   │    │
│  │                         │    │
│  │  • auth (API keys)      │    │
│  │  • priority (1–5)       │    │
│  │  • model routing        │    │
│  │  • request queue        │    │
│  │  • WoL trigger          │    │
│  │  • shutdown watcher     │    │
│  └──────────┬──────────────┘    │
│             │                   │
└─────────────┼───────────────────┘
              │ LAN HTTP
              ▼
┌─────────────────────────────────┐
│       Maszyna obliczeniowa      │
│                                 │
│  ┌─────────────────────────┐    │
│  │   mindgate-agent        │    │
│  │   (Node.js systemd svc) │    │
│  │                         │    │
│  │  • przyjmuje żądania    │    │
│  │  • zarządza kolejką     │    │
│  │  • model router         │    │
│  │  • pipeline support     │    │
│  └──────────┬──────────────┘    │
│             │                   │
│  ┌──────────▼──────────────┐    │
│  │   mindgate-tray         │    │
│  │   (Node.js systray)     │    │
│  │                         │    │
│  │  • status w trayu       │    │
│  │  • toggle "używam PC"   │    │
│  │  • whitelist procesów   │    │
│  └──────────┬──────────────┘    │
│             │                   │
│  ┌──────────▼──────────────┐    │
│  │   Ollama                │    │
│  │   (modele lokalne)      │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │   MCP Servers           │    │
│  │   (narzędzia dla modeli)│    │
│  └─────────────────────────┘    │
└─────────────────────────────────┘
```

---

## Komponenty

| Komponent | Gdzie | Opis |
|---|---|---|
| `mindgate-gate` | Raspberry Pi (Docker) | Brama: auth, queue, WoL, routing |
| `mindgate-agent` | Maszyna (systemd) | Serwis: przyjmuje żądania, zarządza modelami |
| `mindgate-tray` | Maszyna (autostart) | Tray app: status, "używam PC", whitelist |
| Ollama | Maszyna | Serwowanie modeli lokalnych |
| MCP Servers | Maszyna | Narzędzia: internet, kalendarz, vector DB, knowledge base |

Szczegóły każdego komponentu w katalogu `docs/`.

---

## Modele

MindGate definiuje 5 profili modelowych. Konkretne modele (nazwy w Ollama) konfigurujesz sam — profile to tylko semantyczne etykiety które klient podaje w polu `model` żądania.

| Profil | Zastosowanie | Charakterystyka |
|---|---|---|
| `flash` | Szybkie odpowiedzi, formatowanie, podsumowania | Mały, szybki model |
| `reasoning` | Analiza, planowanie, rozwiązywanie problemów | Duży model z chain-of-thought |
| `coding-fast` | Autouzupełnianie, małe poprawki kodu | Wyspecjalizowany, szybki |
| `coding-hard` | Architektura, refactoring, trudne problemy | Duży model coding |
| `extreme` | Maksymalna jakość, brak ograniczeń czasowych | Największy dostępny model, 24/7 |

### Pipeline mode

Zamiast jednego modelu, żądanie może przejść przez kilka:

```json
{
  "model": "pipeline:reasoning+flash",
  "messages": [...]
}
```

`reasoning` analizuje i myśli, `flash` formatuje finalną odpowiedź. Agent sam zarządza przepływem — klient dostaje jedną odpowiedź.

---

## Priorytety

Każde żądanie niesie priorytet `1–5` w nagłówku `X-MindGate-Priority`.

| Priorytet | Znaczenie | WoL |
|---|---|---|
| 1 | Tło, może czekać | Nie budzi |
| 2 | Normalne żądanie | Nie budzi |
| 3 | Ważne, potrzebne szybko | **Budzi komputer** |
| 4 | Pilne | Budzi, awansuje w kolejce |
| 5 | Krytyczne | Budzi, przeskakuje kolejkę |

Domyślny priorytet (gdy brak nagłówka): `2`.

---

## API

MindGate wystawia OpenAI-compatible endpoint. Każde narzędzie które działa z OpenAI, działa z MindGate.

**Endpoint:** `https://<twoj-raspi>/v1/chat/completions`

**Autentykacja:** `Authorization: Bearer <api-key>`

**Dodatkowe nagłówki MindGate:**

```
X-MindGate-Priority: 3
X-MindGate-Model: reasoning
```

Pole `model` w body też działa — `X-MindGate-Model` ma wyższy priorytet.

### Przykład

```bash
curl https://raspi.local/v1/chat/completions \
  -H "Authorization: Bearer mg-twoj-klucz" \
  -H "X-MindGate-Priority: 3" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "reasoning",
    "messages": [
      {"role": "user", "content": "Wytłumacz mi jak działa attention w transformerach"}
    ]
  }'
```

---

## Szybki start

1. [Raspberry Pi — instalacja Gate](docs/01-gate.md)
2. [Maszyna obliczeniowa — instalacja Agent](docs/02-agent.md)
3. [Tray App](docs/03-tray.md)
4. [Modele — konfiguracja Ollama](docs/04-models.md)
5. [Narzędzia MCP](docs/05-mcp.md)
6. [Wake on LAN — konfiguracja](docs/06-wol.md)
7. [Konfiguracja klientów (AntyGraviti, Open WebUI)](docs/07-clients.md)

---

## Struktura repozytorium

```
mindgate/
├── README.md
├── gate/                  # Raspberry Pi — Docker container
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── src/
│   │   ├── index.js       # Fastify app
│   │   ├── auth.js        # API key validation
│   │   ├── queue.js       # Priority queue
│   │   ├── router.js      # Model/server routing
│   │   ├── wol.js         # Wake on LAN
│   │   └── shutdown.js    # Shutdown signaling
│   └── config/
│       └── config.yml     # Klucze, adresy, priorytety
│
├── agent/                 # Maszyna obliczeniowa — systemd service
│   ├── src/
│   │   ├── index.js       # Express app
│   │   ├── queue.js       # Local queue manager
│   │   ├── router.js      # Model router + pipeline
│   │   ├── ollama.js      # Ollama client
│   │   └── mcp.js         # MCP tool orchestration
│   ├── config/
│   │   └── models.yml     # Profile modeli → nazwy Ollama
│   └── mindgate-agent.service  # systemd unit
│
├── tray/                  # Maszyna obliczeniowa — tray app
│   ├── src/
│   │   ├── index.js       # systray entry point
│   │   ├── ipc.js         # komunikacja z agent
│   │   └── idle.js        # WinAPI idle detection
│   └── package.json
│
└── docs/
    ├── 01-gate.md
    ├── 02-agent.md
    ├── 03-tray.md
    ├── 04-models.md
    ├── 05-mcp.md
    ├── 06-wol.md
    └── 07-clients.md
```
