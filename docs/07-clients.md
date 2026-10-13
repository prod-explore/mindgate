# Konfiguracja klientów

MindGate wystawia OpenAI-compatible API. Konfiguracja w każdym kliencie sprowadza się do trzech rzeczy: URL, klucz API, nazwa modelu.

**Nazwa modelu** to jedno z dwóch:

- **alias** — krótka nazwa, którą ustawiasz w hubie (`smart`, `flash`, `coding-hard`), z jawną listą zapasowych modeli; zmieniasz, co się za nią kryje, bez ruszania klientów,
- **model dostawcy** — `dostawca/model`, np. `openrouter/deepseek/deepseek-chat`; bez żadnego fallbacku.

Co jest dostępne, pokazuje `GET /v1/models` (klienty pokazują tę listę same). Każdy klient powinien mieć **własny klucz** (`keys create <nazwa>`): osobne limity, priorytet i, jeśli trzeba, `--local-only`. Opisy aliasów, kluczy i limitów: [01 - Hub](01-gate.md), wszystkie endpointy i kody błędów: [08 - API](08-api.md).

---

## AntyGraviti (Google)

AntyGraviti obsługuje własne LLM endpoints przez ustawienia projektu.

1. Otwórz projekt w AntyGraviti
2. Przejdź do **Settings** → **AI Model** lub **Custom AI Provider**
3. Ustaw:
   - **API Endpoint**: `https://raspi.twojadomena.pl/v1`
   - **API Key**: `mg-twoj-klucz`
   - **Model**: `smart` (lub dowolny inny alias / model z `GET /v1/models`)

Jeśli AntyGraviti wymaga pola `baseURL` w formacie JSON:

```json
{
  "baseURL": "https://raspi.twojadomena.pl/v1",
  "apiKey": "mg-twoj-klucz",
  "model": "coding-hard"
}
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

Modele pojawiają się automatycznie (hub zwraca listę przez `/v1/models`).

### Priorytet w Open WebUI

Open WebUI nie wysyła niestandardowych nagłówków — żądania będą miały domyślny priorytet Twojego klucza API. Jeśli chcesz wyższy priorytet dla konkretnych rozmów, skonfiguruj osobny klucz z wyższym `--priority`. Rozmowy z danymi prywatnymi możesz skierować na osobne połączenie z kluczem `--local-only`: hub nie wyśle ich do chmury, nawet przez pomyłkę w wyborze modelu.

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
      "title": "MindGate — Smart",
      "provider": "openai",
      "model": "smart",
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
    model="smart",
    messages=[
        {"role": "user", "content": "Wytłumacz mi quicksort"}
    ],
    extra_headers={
        "X-MindGate-Priority": "3",        # 1-5, w zakresie dozwolonym dla klucza
        "X-MindGate-Local-Only": "true",   # opcjonalnie: tylko modele lokalne, fallbacki też
    }
)
print(response.model)   # kto naprawdę odpowiedział, np. "openrouter/deepseek/deepseek-chat"


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

Konfiguracja nginx jest wtedy opcjonalna — hub może być wystawiony bezpośrednio.

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

Hub zwraca modele i aliasy dostępne dla danego klucza przez standardowy endpoint:

```bash
curl https://raspi.twojadomena.pl/v1/models \
  -H "Authorization: Bearer mg-twoj-klucz"
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

Poza polami OpenAI są dodatki, które klient może zignorować: `kind` (`chat` / `embedding`), `tags`, `locality` (`local` / `cloud`), `context_length`, `supports` (gdy dostawca podaje możliwości) oraz `status` (`online` / `asleep` / `waking` — dla maszyn z usypianiem). Pola, o których dostawca nic nie mówi, są pominięte — brak pola znaczy „nie wiadomo”, nie „nie obsługuje”.

Klucz z `allowed_models` widzi tylko swoje modele; wywołanie z `local_only` (klucz lub nagłówek) — tylko te, do których może dotrzeć.

---

## Zużycie i limity z poziomu klienta

```bash
curl https://raspi.twojadomena.pl/v1/usage -H "Authorization: Bearer $MINDGATE_KEY"
```

Zwraca zużycie dziś i w tym miesiącu, limity klucza oraz moment, w którym doba i miesiąc się zerują. Po przekroczeniu limitu klient dostaje `429` z kodem `rate_limited` (za szybko: odczekaj `Retry-After` sekund) albo `budget_exhausted` (limit dobowy lub miesięczny wyczerpany: `reset_at` mówi, kiedy wróci) — warto je odróżniać.
