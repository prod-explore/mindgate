# Narzędzia MCP — Model Context Protocol

MCP (Model Context Protocol) to otwarty standard stworzony przez Anthropic, który pozwala modelom AI używać zewnętrznych narzędzi w ustandaryzowany sposób. Każdy MCP server to osobny proces który dostarcza zestaw narzędzi — model może je wywoływać w trakcie generowania odpowiedzi.

W MindGate MCP servers działają na maszynie obliczeniowej, obok agenta i Ollama.

---

## Jak to działa

```
Klient wysyła żądanie
        ↓
Agent rozpoznaje że model potrzebuje narzędzia
(np. "przeszukaj internet w poszukiwaniu X")
        ↓
Agent wywołuje odpowiedni MCP server
        ↓
MCP server wykonuje akcję (przeglądarka, API, baza danych...)
        ↓
Wynik wraca do modelu jako kontekst
        ↓
Model formułuje finalną odpowiedź
```

Dla klienta (AntyGraviti, itp.) cały ten proces jest niewidoczny — dostaje jedną odpowiedź.

---

## MCP servers w MindGate

### 1. Internet i wyszukiwanie

**`@modelcontextprotocol/server-brave-search`**

Przeszukiwanie internetu przez Brave Search API. Bez śledzenia, bez bańki filtrowania.

```bash
npm install -g @modelcontextprotocol/server-brave-search
```

Konfiguracja — potrzebujesz klucza API z https://api.search.brave.com:

```yaml
mcp_servers:
  brave-search:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-brave-search"]
    env:
      BRAVE_API_KEY: "twoj-klucz-brave"
    tools:
      - brave_web_search
      - brave_local_search
```

**`@modelcontextprotocol/server-puppeteer`**

Pełna przeglądarka (Chromium headless). Model może wejść na stronę, kliknąć, wypełnić formularze, pobrać treść.

```bash
npm install -g @modelcontextprotocol/server-puppeteer
```

```yaml
  puppeteer:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-puppeteer"]
    tools:
      - puppeteer_navigate
      - puppeteer_screenshot
      - puppeteer_click
      - puppeteer_fill
      - puppeteer_evaluate
```

---

### 2. Pliki i system

**`@modelcontextprotocol/server-filesystem`**

Dostęp do plików lokalnych. Możesz ograniczyć do konkretnych katalogów.

```bash
npm install -g @modelcontextprotocol/server-filesystem
```

```yaml
  filesystem:
    command: "npx"
    args:
      - "-y"
      - "@modelcontextprotocol/server-filesystem"
      - "/home/twoj-user/dokumenty"     # dozwolony katalog
      - "/home/twoj-user/projekty"      # można dodać wiele
    tools:
      - read_file
      - write_file
      - list_directory
      - search_files
```

**`@modelcontextprotocol/server-git`**

Operacje na repozytoriach Git — historia, diff, commity.

```yaml
  git:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-git", "--repository", "/home/twoj-user/projekty"]
    tools:
      - git_log
      - git_diff
      - git_status
      - git_show
```

---

### 3. Vector Database — pamięć semantyczna

**`mcp-server-qdrant`** (lub ChromaDB)

Vector database pozwala modelowi przechowywać i wyszukiwać wiedzę semantycznie — nie po słowach kluczowych, ale po znaczeniu. To właśnie "pamięć" o której myślisz.

Użycie: zapisujesz dokumenty, notatki, artykuły → model może je przeszukiwać pytając "co wiem o X".

```bash
# Qdrant — uruchom jako Docker
docker run -d -p 6333:6333 qdrant/qdrant

# MCP server dla Qdrant
pip install mcp-server-qdrant --break-system-packages
```

```yaml
  qdrant:
    command: "python"
    args: ["-m", "mcp_server_qdrant"]
    env:
      QDRANT_URL: "http://localhost:6333"
      COLLECTION_NAME: "mindgate-knowledge"
      EMBEDDING_MODEL: "sentence-transformers/all-MiniLM-L6-v2"
    tools:
      - qdrant_store          # zapisz dokument/notatkę
      - qdrant_find           # znajdź semantycznie podobne treści
```

---

### 4. Knowledge Base — baza wiedzy

**`@modelcontextprotocol/server-memory`**

Prostszy wariant — key-value store dla faktów i notatek. Model może zapisywać i odczytywać informacje między rozmowami.

```bash
npm install -g @modelcontextprotocol/server-memory
```

```yaml
  memory:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-memory"]
    env:
      MEMORY_FILE_PATH: "/home/twoj-user/.mindgate/memory.json"
    tools:
      - create_entities
      - create_relations
      - add_observations
      - search_nodes
      - open_nodes
```

Przechowuje wiedzę jako graf encji i relacji — np. "Jan pracuje w firmie X", "Projekt Y używa technologii Z".

---

### 5. Sejf — bezpieczne sekrety

**`mcp-server-1password`** lub własne rozwiązanie

Do przechowywania API kluczy, haseł, tokenów które model może używać w narzędziach.

Prostsze podejście — lokalny zaszyfrowany plik:

```yaml
  secrets:
    command: "node"
    args: ["/home/twoj-user/mindgate/mcp/secrets-server.js"]
    env:
      SECRETS_FILE: "/home/twoj-user/.mindgate/secrets.enc"
      MASTER_KEY_ENV: "MINDGATE_MASTER_KEY"
    tools:
      - get_secret        # pobierz sekret po nazwie
      - list_secret_names # lista dostępnych sekretów (bez wartości)
```

Model może poprosić o `get_secret("OPENAI_API_KEY")` i użyć go w narzędziu — nigdy nie widzi klucza w plaintext w konwersacji.

---

### 6. Kalendarz i zewnętrzne usługi

**`@modelcontextprotocol/server-google-calendar`** (wymaga OAuth)

```yaml
  google-calendar:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-google-calendar"]
    env:
      GOOGLE_CLIENT_ID: "..."
      GOOGLE_CLIENT_SECRET: "..."
      GOOGLE_REFRESH_TOKEN: "..."
    tools:
      - list_events
      - create_event
      - update_event
      - delete_event
```

**`@modelcontextprotocol/server-slack`** — jeśli używasz Slacka

**`mcp-server-github`** — operacje na GitHub (issues, PRs, repozytoria)

---

### 7. Bazy danych i kod

**`@modelcontextprotocol/server-sqlite`**

Lokalna baza SQLite — model może tworzyć tabele, wstawiać i odpytywać dane.

```yaml
  sqlite:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "/home/twoj-user/.mindgate/data.db"]
    tools:
      - read_query
      - write_query
      - create_table
      - list_tables
      - describe_table
```

**`@modelcontextprotocol/server-postgres`** — jeśli masz PostgreSQL

---

## Konfiguracja w agencie

Wszystkie MCP servers definiujesz w jednym pliku `agent/config/mcp.yml`:

```yaml
mcp_servers:
  brave-search:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-brave-search"]
    env:
      BRAVE_API_KEY: "${BRAVE_API_KEY}"    # ze zmiennych środowiskowych

  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/twoj-user"]

  memory:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-memory"]
    env:
      MEMORY_FILE_PATH: "/home/twoj-user/.mindgate/memory.json"

  sqlite:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-sqlite", "--db-path", "/home/twoj-user/.mindgate/data.db"]

  qdrant:
    command: "python"
    args: ["-m", "mcp_server_qdrant"]
    env:
      QDRANT_URL: "http://localhost:6333"
      COLLECTION_NAME: "mindgate-knowledge"

# Które modele mają dostęp do których narzędzi
permissions:
  flash:
    - brave-search
    - memory
  reasoning:
    - brave-search
    - memory
    - filesystem
    - sqlite
    - qdrant
  coding-fast:
    - filesystem
    - git
    - sqlite
  coding-hard:
    - filesystem
    - git
    - sqlite
    - brave-search
  extreme:
    - "*"    # wszystkie narzędzia
```

---

## Popularne MCP servers — pełna lista

Oficjalna lista: https://modelcontextprotocol.io/servers

Najważniejsze:

| Server | Do czego |
|--------|----------|
| `brave-search` | Wyszukiwanie w internecie |
| `puppeteer` | Pełna przeglądarka headless |
| `filesystem` | Pliki lokalne |
| `git` | Repozytoria Git |
| `github` | GitHub API |
| `sqlite` | Lokalna baza SQLite |
| `postgres` | PostgreSQL |
| `memory` | Trwała pamięć (graf wiedzy) |
| `qdrant` | Vector search (pamięć semantyczna) |
| `google-maps` | Mapy, miejsca, trasy |
| `google-calendar` | Kalendarz Google |
| `slack` | Slack workspace |
| `fetch` | Pobieranie treści URL |
| `time` | Aktualny czas i strefy czasowe |
| `docker` | Zarządzanie kontenerami Docker |
| `kubernetes` | Klastry Kubernetes |

---

## Qdrant — uruchomienie

Qdrant to lokalny serwer vector database. Uruchamiasz go raz i działa w tle:

```bash
docker run -d \
  --name qdrant \
  --restart unless-stopped \
  -p 6333:6333 \
  -v ~/.mindgate/qdrant:/qdrant/storage \
  qdrant/qdrant
```

Panel webowy: http://localhost:6333/dashboard

---

## Troubleshooting

**MCP server nie startuje**
Sprawdź czy pakiet jest zainstalowany: `npx -y @modelcontextprotocol/server-X --version`. Sprawdź logi agenta.

**Model nie używa narzędzi**
Nie wszystkie modele w Ollama obsługują function calling / tool use. Modele które działają dobrze z MCP: `qwen2.5`, `llama3.1`, `mistral-nemo`. Sprawdź dokumentację modelu na ollama.com.

**Qdrant nie ma embeddingów**
Potrzebujesz modelu embeddingowego. Ollama może go dostarczyć: `ollama pull nomic-embed-text`. Ustaw w konfiguracji Qdrant MCP.
