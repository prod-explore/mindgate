# Agent — Maszyna obliczeniowa

Serwis Node.js działający jako `systemd` service na maszynie obliczeniowej. Uruchamia się automatycznie po starcie systemu (w tym po Wake on LAN), przyjmuje żądania z Gate, zarządza kolejką lokalną, routuje do modeli Ollama i orkiestruje narzędzia MCP.

---

## Wymagania

- Linux (Ubuntu 22.04+ lub Debian 12+) albo Windows (z WSL2 dla systemd — patrz niżej)
- Node.js 20+
- Ollama zainstalowane i działające
- GPU z CUDA (opcjonalnie, ale bardzo zalecane dla dużych modeli)

---

## Instalacja

### 1. Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Sprawdź czy działa:

```bash
ollama list
curl http://localhost:11434/api/tags
```

### 3. Agent

```bash
cd mindgate/agent
npm install
cp config/models.example.yml config/models.yml
nano config/models.yml
```

---

## Konfiguracja modeli

Plik `config/models.yml` mapuje semantyczne profile na konkretne modele Ollama:

```yaml
models:
  flash:
    ollama: "qwen2.5:3b"          # mały, szybki model
    max_tokens: 2048
    description: "Szybkie odpowiedzi, formatowanie, podsumowania"

  reasoning:
    ollama: "qwq:32b"             # model z chain-of-thought
    max_tokens: 8192
    description: "Analiza, planowanie, rozwiązywanie problemów"

  coding-fast:
    ollama: "qwen2.5-coder:7b"    # szybki model do kodu
    max_tokens: 4096
    description: "Autouzupełnianie, małe poprawki"

  coding-hard:
    ollama: "qwen2.5-coder:32b"   # duży model do kodu
    max_tokens: 8192
    description: "Architektura, refactoring, trudne problemy"

  extreme:
    ollama: "llama3.3:70b"        # największy dostępny
    max_tokens: 16384
    description: "Maksymalna jakość, bez ograniczeń czasowych"

pipelines:
  reasoning+flash:
    steps:
      - model: reasoning
        role: "Przeanalizuj problem i podaj szczegółową odpowiedź"
      - model: flash
        role: "Sformułuj zwięzłą, czytelną odpowiedź na podstawie analizy"

  coding-hard+flash:
    steps:
      - model: coding-hard
        role: "Napisz kod rozwiązujący problem"
      - model: flash
        role: "Dodaj komentarze i wyjaśnienia do kodu"

server:
  port: 3001
  host: "0.0.0.0"

ollama:
  url: "http://localhost:11434"
  request_timeout_ms: 600000      # 10 minut dla dużych modeli
```

### Jakie modele wybrać?

To zależy od Twojej karty GPU i ilości VRAM. Ogólna zasada:

| VRAM | Flash | Reasoning | Coding Fast | Coding Hard | Extreme |
|------|-------|-----------|-------------|-------------|---------|
| 8GB  | 1–3B  | 7B Q4     | 3–7B        | 7B Q4       | 13B Q4  |
| 16GB | 3B    | 14B Q4    | 7B          | 14B Q4      | 32B Q4  |
| 24GB | 3B    | 32B Q4    | 7B          | 32B Q4      | 70B Q4  |
| 48GB+| 3B    | 32B Q8    | 7B          | 32B Q8      | 70B Q8  |

Q4/Q8 to kwantyzacja — Q4 zużywa ~50% mniej VRAM, Q8 jest bliżej full precision.

Sprawdź dostępne modele: `ollama list` i `ollama search <nazwa>`.

---

## Systemd service

### Linux (natywny)

Skopiuj plik jednostki:

```bash
sudo cp mindgate/agent/mindgate-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable mindgate-agent
sudo systemctl start mindgate-agent
```

Zawartość `mindgate-agent.service`:

```ini
[Unit]
Description=MindGate Agent
After=network.target ollama.service
Wants=ollama.service

[Service]
Type=simple
User=twoj-user
WorkingDirectory=/home/twoj-user/mindgate/agent
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=MINDGATE_CONFIG=/home/twoj-user/mindgate/agent/config/models.yml

# Logowanie do journald
StandardOutput=journal
StandardError=journal
SyslogIdentifier=mindgate-agent

[Install]
WantedBy=multi-user.target
```

Logi:

```bash
journalctl -u mindgate-agent -f
```

### Windows (bez WSL)

Na Windows systemd nie istnieje. Używamy `node-windows` żeby zarejestrować serwis w Windows Services:

```bash
cd mindgate/agent
npm install node-windows --save-dev
node install-service.js
```

Plik `install-service.js`:

```javascript
import { Service } from 'node-windows'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const svc = new Service({
  name: 'MindGate Agent',
  description: 'MindGate AI Agent — lokalny serwis modeli',
  script: path.join(__dirname, 'src', 'index.js'),
  nodeOptions: [],
  env: [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'MINDGATE_CONFIG', value: path.join(__dirname, 'config', 'models.yml') }
  ]
})

svc.on('install', () => {
  console.log('Serwis zainstalowany, uruchamiam...')
  svc.start()
})

svc.install()
```

Odinstalowanie:

```bash
node uninstall-service.js
```

---

## API agenta

Agent wystawia wewnętrzne API tylko dla Gate (nie dla klientów zewnętrznych).

### POST /v1/chat/completions

Standardowy OpenAI-compatible endpoint. Gate proxy'uje żądania tutaj.

```json
{
  "model": "reasoning",
  "messages": [
    {"role": "user", "content": "..."}
  ],
  "stream": true
}
```

Pipeline:

```json
{
  "model": "pipeline:reasoning+flash",
  "messages": [...]
}
```

### GET /health

```json
{
  "status": "ok",
  "models_loaded": ["flash", "reasoning"],
  "queue_length": 2,
  "ollama": "ok"
}
```

### POST /internal/shutdown-request

Wysyłane przez Gate gdy system jest bezczynny. Agent przekazuje do Tray App. Tray App decyduje czy wykonać shutdown.

```json
{
  "idle_minutes": 15
}
```

### GET /internal/status

Status dla Gate — czy komputer jest aktywny, czy można go wyłączyć.

```json
{
  "user_active": true,
  "last_input_seconds_ago": 45,
  "queue_empty": true,
  "safe_to_shutdown": false
}
```

---

## Pipeline — jak działa

Gdy model to `pipeline:X+Y`, agent:

1. Wysyła oryginalne `messages` do modelu `X`
2. Odpowiedź X dodaje do historii jako `assistant`
3. Dodaje systemowy prompt dla modelu `Y` ("sformułuj odpowiedź na podstawie powyższej analizy")
4. Wysyła całość do modelu `Y`
5. Odpowiedź `Y` zwraca klientowi

Dla klienta wygląda to identycznie jak pojedyncze żądanie — jedna odpowiedź, jeden stream.

---

## Struktura kodu

```
agent/src/
├── index.js       Express app, routing żądań
├── queue.js       Lokalna kolejka (gdy równoległe żądania przychodzą)
├── router.js      Rozwiązywanie profilu modelu → ollama model name
├── ollama.js      Klient Ollama, streaming, obsługa błędów
├── pipeline.js    Orchestracja multi-model pipeline
├── mcp.js         Inicjalizacja i wywołanie MCP servers
└── shutdown.js    Obsługa /internal/shutdown-request, IPC z tray
```

---

## Ollama — przydatne komendy

```bash
# Pobierz model
ollama pull qwen2.5:3b

# Lista modeli
ollama list

# Uruchom model interaktywnie (test)
ollama run qwen2.5:3b

# Status serwisu Ollama
systemctl status ollama

# Logi Ollama
journalctl -u ollama -f

# Usuń model (zwalnia VRAM/dysk)
ollama rm nazwa-modelu
```

---

## Troubleshooting

**Agent nie startuje po WoL**
Sprawdź `systemctl status mindgate-agent`. Najczęściej: Ollama jeszcze się nie uruchomiła — dodaj `After=ollama.service` i `Wants=ollama.service` do unit file, albo zwiększ `RestartSec`.

**Ollama zwraca błąd CUDA out of memory**
Model jest za duży dla Twojego VRAM. Użyj bardziej skwantyzowanego modelu (Q4 zamiast Q8) lub mniejszego.

**Pipeline nie działa, timeout**
Dwa duże modele sekwencyjnie mogą zająć dużo czasu. Zwiększ `ollama.request_timeout_ms` w configu i `proxy_read_timeout` w nginx na RasPi.

**Żądania gubią się po restarcie**
Agent nie persystuje kolejki (in-memory). To celowe — po restarcie klienci powinni ponowić żądania. Jeśli potrzebujesz trwałej kolejki, dodaj Redis (patrz issues w repo).
