# Gate — Raspberry Pi

Kontener Docker na Raspberry Pi. Pełni rolę jedynego punktu wejścia do całego systemu MindGate. Zewnętrzne żądania trafiają tutaj, są weryfikowane, wzbogacane o priorytet i routing, a następnie przekazywane do maszyny obliczeniowej.

---

## Wymagania

- Raspberry Pi 4 lub nowszy (ARM64), minimum 2GB RAM
- Docker + Docker Compose
- Stały adres IP w sieci lokalnej (ustaw w routerze DHCP reservation)
- Port 443 wystawiony na świat (opcjonalnie, dla dostępu spoza sieci)

---

## Instalacja

### 1. Klonuj repozytorium

```bash
git clone https://github.com/twoj-user/mindgate.git
cd mindgate/gate
```

### 2. Skonfiguruj

```bash
cp config/config.example.yml config/config.yml
nano config/config.yml
```

Minimalna konfiguracja:

```yaml
server:
  port: 3000
  host: "0.0.0.0"

agent:
  url: "http://192.168.1.XXX:3001"   # IP maszyny obliczeniowej
  timeout_ms: 120000                  # 2 minuty dla dużych modeli

wol:
  mac: "AA:BB:CC:DD:EE:FF"           # MAC maszyny obliczeniowej
  broadcast: "192.168.1.255"
  min_priority: 3                     # od jakiego priorytetu budzić

auth:
  keys:
    - name: "antigravity"
      key: "mg-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      default_priority: 2
    - name: "scripts"
      key: "mg-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
      default_priority: 1

queue:
  max_size: 100
  request_timeout_ms: 300000          # 5 minut max czekania w kolejce

shutdown:
  idle_minutes: 15                    # po ilu minutach bez żądań wysłać sygnał shutdown
```

### 3. Uruchom

```bash
docker compose up -d
```

### 4. Sprawdź logi

```bash
docker compose logs -f gate
```

---

## Reverse Proxy (nginx)

Gate nasłuchuje na porcie 3000 wewnątrz sieci. Nginx na RasPi wystawia go na HTTPS.

Instalacja nginx na Raspberry Pi OS:

```bash
sudo apt install nginx certbot python3-certbot-nginx
```

Konfiguracja `/etc/nginx/sites-available/mindgate`:

```nginx
server {
    listen 443 ssl;
    server_name raspi.twojadomena.pl;

    ssl_certificate     /etc/letsencrypt/live/raspi.twojadomena.pl/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/raspi.twojadomena.pl/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;    # długie żądania do dużych modeli
        proxy_send_timeout 300s;
    }
}
```

Jeśli nie masz domeny (tylko sieć lokalna), możesz użyć self-signed cert lub Caddy z lokalnym HTTPS.

---

## Jak działa Gate

### Flow każdego żądania

```
1. Żądanie przychodzi na POST /v1/chat/completions
2. auth.js     → sprawdź Bearer token, wyznacz domyślny priorytet klucza
3. router.js   → ustal docelowy model (z nagłówka X-MindGate-Model lub pola "model")
4. queue.js    → wstaw do kolejki priorytetowej
5. wol.js      → jeśli priority >= min_priority i komputer śpi → wyślij WoL packet
6. queue.js    → gdy agent jest gotowy, wyślij żądanie
7. agent       → przetwarza, odpowiada
8. Gate        → zwraca odpowiedź klientowi (streaming lub complete)
```

### Autentykacja

Każde żądanie musi nieść nagłówek:

```
Authorization: Bearer mg-twoj-klucz
```

Klucze definiujesz w `config.yml`. Każdy klucz ma:
- `name` — czytelna nazwa (logi)
- `key` — losowy string, minimum 32 znaki
- `default_priority` — domyślny priorytet gdy klient nie poda `X-MindGate-Priority`

Generowanie bezpiecznego klucza:

```bash
node -e "console.log('mg-' + require('crypto').randomBytes(32).toString('hex'))"
```

### Kolejka priorytetowa

Żądania czekają w kolejce gdy agent jest zajęty. Kolejka sortuje według priorytetu (5 → 1), a w ramach tego samego priorytetu — FIFO.

Żądanie z priorytetem 5 zawsze wyprzedzi oczekujące żądania 1–4.

Nagłówki które klient może wysłać:

```
X-MindGate-Priority: 3     (1-5, domyślnie z config klucza)
X-MindGate-Model: reasoning
```

### Wake on LAN

Gdy przychodzi żądanie z priorytetem `>= min_priority` (domyślnie 3) i ostatni status agenta to "offline" lub "unknown", Gate wysyła magic packet WoL na adres MAC maszyny.

Gate następnie czeka na pojawienie się agenta (polling co 2 sekundy, max 120 sekund). Żądanie czeka w kolejce przez ten czas.

Wymagania po stronie maszyny obliczeniowej: [Wake on LAN — konfiguracja](06-wol.md).

### Sygnał shutdown

Gate śledzi czas ostatniego żądania. Po `idle_minutes` bez żądań wysyła do agenta `POST /internal/shutdown-request`. Agent decyduje czy faktycznie wyłączyć komputer (sprawdza aktywność użytkownika przez tray app).

---

## Struktura kodu

```
gate/src/
├── index.js       Fastify app, rejestracja routów i pluginów
├── auth.js        Walidacja Bearer tokenów, wyznaczanie priorytetu
├── queue.js       Priority queue, zarządzanie żądaniami w kolejce
├── router.js      Parsowanie modelu z nagłówków/body, aliasy
├── wol.js         Wysyłanie magic packet, polling dostępności agenta
└── shutdown.js    Idle timer, wysyłanie sygnału shutdown do agenta
```

### index.js — szkielet

```javascript
import Fastify from 'fastify'
import { authenticate } from './auth.js'
import { enqueue } from './queue.js'
import { resolveModel } from './router.js'
import { ensureAwake } from './wol.js'

const app = Fastify({ logger: true })

app.post('/v1/chat/completions', async (req, reply) => {
  const apiKey = authenticate(req)               // rzuca 401 jeśli invalid
  const model  = resolveModel(req, apiKey)       // X-MindGate-Model lub body.model
  const priority = req.headers['x-mindgate-priority']
    ? parseInt(req.headers['x-mindgate-priority'])
    : apiKey.default_priority

  await ensureAwake(priority)                    // WoL jeśli potrzeba
  const response = await enqueue({ req, model, priority })
  return reply.send(response)
})

app.get('/health', async () => ({ status: 'ok' }))

await app.listen({ port: 3000, host: '0.0.0.0' })
```

---

## Docker Compose

```yaml
services:
  gate:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./config:/app/config:ro
    environment:
      - NODE_ENV=production
    networks:
      - mindgate

networks:
  mindgate:
    driver: bridge
```

---

## Zmienne środowiskowe

Zamiast `config.yml` możesz użyć zmiennych środowiskowych (przydatne dla sekretów):

| Zmienna | Opis |
|---|---|
| `MINDGATE_AGENT_URL` | URL agenta na maszynie obliczeniowej |
| `MINDGATE_WOL_MAC` | MAC adres maszyny |
| `MINDGATE_API_KEYS` | JSON array kluczy (dla Docker secrets) |

---

## Troubleshooting

**Gate nie może dosięgnąć agenta**
Sprawdź `agent.url` w configu — powinien być lokalny IP, nie hostname. Pinguj z RasPi: `ping 192.168.1.XXX`.

**WoL nie działa**
Sprawdź [docs/06-wol.md](06-wol.md). Najczęstsza przyczyna: WoL nie jest włączony w BIOS/UEFI maszyny.

**Żądania czekają w nieskończoność**
Sprawdź czy agent działa: `curl http://<ip-maszyny>:3001/health`. Sprawdź logi agenta.

**401 Unauthorized**
Upewnij się że nagłówek to `Authorization: Bearer mg-twoj-klucz` (ze spacją po "Bearer").
