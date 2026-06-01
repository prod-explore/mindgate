# Konfiguracja klientów

MindGate wystawia OpenAI-compatible API. Konfiguracja w każdym kliencie sprowadza się do trzech rzeczy: URL, klucz API, nazwa modelu.

---

## AntyGraviti (Google)

AntyGraviti obsługuje własne LLM endpoints przez ustawienia projektu.

1. Otwórz projekt w AntyGraviti
2. Przejdź do **Settings** → **AI Model** lub **Custom AI Provider**
3. Ustaw:
   - **API Endpoint**: `https://raspi.twojadomena.pl/v1`
   - **API Key**: `mg-twoj-klucz`
   - **Model**: `reasoning` (lub inny profil)

Jeśli AntyGraviti wymaga pola `baseURL` w formacie JSON:

```json
{
  "baseURL": "https://raspi.twojadomena.pl/v1",
  "apiKey": "mg-twoj-klucz",
  "model": "coding-hard"
}
```

Dla pipeline:
```
model: "pipeline:reasoning+flash"
```

---

## Open WebUI

Open WebUI to przeglądarkowy frontend dla LLM — polecany jako główny interfejs do czatowania.

### Instalacja (Docker na dowolnej maszynie)

```bash
docker run -d \
  --name open-webui \
  -p 3000:8080 \
  -e OPENAI_API_BASE_URL=https://raspi.twojadomena.pl/v1 \
  -e OPENAI_API_KEY=mg-twoj-klucz \
  ghcr.io/open-webui/open-webui:main
```

Otwórz: http://localhost:3000

### Dodanie modeli

W Open WebUI: **Settings** → **Connections** → **OpenAI API**:
- URL: `https://raspi.twojadomena.pl/v1`
- Key: `mg-twoj-klucz`

Modele pojawiają się automatycznie (Gate zwraca listę przez `/v1/models`).

### Priorytet w Open WebUI

Open WebUI nie wysyła niestandardowych nagłówków — żądania będą miały domyślny priorytet Twojego klucza API. Jeśli chcesz wyższy priorytet dla konkretnych rozmów, skonfiguruj osobny klucz z wyższym `default_priority`.

---

## Continue.dev (VS Code / JetBrains)

Continue to rozszerzenie do VS Code i JetBrains dla asystenta kodowania.

### VS Code

Zainstaluj rozszerzenie **Continue** z marketplace.

Edytuj `~/.continue/config.json`:

```json
{
  "models": [
    {
      "title": "MindGate — Coding Fast",
      "provider": "openai",
      "model": "coding-fast",
      "apiBase": "https://raspi.twojadomena.pl/v1",
      "apiKey": "mg-twoj-klucz"
    },
    {
      "title": "MindGate — Reasoning",
      "provider": "openai",
      "model": "reasoning",
      "apiBase": "https://raspi.twojadomena.pl/v1",
      "apiKey": "mg-twoj-klucz"
    },
    {
      "title": "MindGate — Extreme",
      "provider": "openai",
      "model": "extreme",
      "apiBase": "https://raspi.twojadomena.pl/v1",
      "apiKey": "mg-twoj-klucz"
    }
  ],
  "tabAutocompleteModel": {
    "title": "MindGate — Flash",
    "provider": "openai",
    "model": "coding-fast",
    "apiBase": "https://raspi.twojadomena.pl/v1",
    "apiKey": "mg-twoj-klucz"
  }
}
```

---

## Cursor

Cursor obsługuje custom OpenAI endpoints.

**Settings** → **Models** → **Add Model**:
- Model name: `coding-hard` (lub inny)
- API URL: `https://raspi.twojadomena.pl/v1`
- API Key: `mg-twoj-klucz`

Lub przez `.cursor/settings.json` w projekcie:

```json
{
  "ai.openaiApiBase": "https://raspi.twojadomena.pl/v1",
  "ai.openaiApiKey": "mg-twoj-klucz",
  "ai.model": "coding-hard"
}
```

---

## Własny skrypt / aplikacja

Każda biblioteka kompatybilna z OpenAI działa od razu.

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://raspi.twojadomena.pl/v1",
    api_key="mg-twoj-klucz"
)

response = client.chat.completions.create(
    model="reasoning",
    messages=[
        {"role": "user", "content": "Wytłumacz mi quicksort"}
    ],
    extra_headers={
        "X-MindGate-Priority": "3"
    }
)

print(response.choices[0].message.content)
```

### Node.js

```javascript
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'https://raspi.twojadomena.pl/v1',
  apiKey: 'mg-twoj-klucz',
  defaultHeaders: {
    'X-MindGate-Priority': '2'
  }
})

const response = await client.chat.completions.create({
  model: 'flash',
  messages: [{ role: 'user', content: 'Cześć!' }],
  stream: true
})

for await (const chunk of response) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '')
}
```

---

## Sieci lokalna vs zewnętrzna

### Tylko sieć lokalna (bez domeny)

Jeśli nie potrzebujesz dostępu spoza domu, możesz używać lokalnego IP RasPi:

- URL: `http://192.168.1.50:3000/v1` (bez HTTPS)
- Nie potrzebujesz certyfikatu TLS

Konfiguracja nginx jest wtedy opcjonalna — Gate może być wystawiony bezpośrednio.

### Dostęp z zewnątrz (domowy serwer)

Opcja 1 — **port forwarding**: przekieruj port 443 w routerze na RasPi, użyj Let's Encrypt.

Opcja 2 — **Tailscale / Cloudflare Tunnel**: VPN mesh albo tunel bez otwierania portów. Polecane dla bezpieczeństwa.

Tailscale jest najprostszy:

```bash
# Na RasPi
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# URL w klientach: http://100.x.x.x:3000/v1 (Tailscale IP)
```

---

## Lista modeli — endpoint /v1/models

Gate zwraca listę dostępnych profili przez standardowy endpoint:

```bash
curl https://raspi.twojadomena.pl/v1/models \
  -H "Authorization: Bearer mg-twoj-klucz"
```

```json
{
  "object": "list",
  "data": [
    {"id": "flash", "object": "model"},
    {"id": "reasoning", "object": "model"},
    {"id": "coding-fast", "object": "model"},
    {"id": "coding-hard", "object": "model"},
    {"id": "extreme", "object": "model"},
    {"id": "pipeline:reasoning+flash", "object": "model"},
    {"id": "pipeline:coding-hard+flash", "object": "model"}
  ]
}
```

Klienty które odpytują `/v1/models` (np. Open WebUI) pokażą tę listę automatycznie.
