# The admin panel

The panel is a web page for managing the hub without `curl`: providers, models, client keys, usage, the request log and the models on GPU machines. It does exactly what the [administrator API](08-api.md) does — it has no path of its own to the database.

- **Address:** `http://<hub>:3000/admin/` (`/admin` redirects to `/admin/`).
- **Sign-in:** the value of `MINDGATE_ADMIN_TOKEN` from the hub's environment — the same token that protects `/admin/api`.
- **Language and theme:** English. The theme is light, dark or automatic; the browser remembers the choice.

## Running it

**Docker** — the image contains the hub and the built panel; there is nothing else to do. The only thing that changed is where the image is built from: **the build context is the repository root**, because `panel/` goes into the image too. `docker compose up -d --build` in `gate/` does the same as before (`docker-compose.yml` already has `context: ..`). By hand:

```bash
docker build -f gate/Dockerfile -t mindgate-hub .      # from the repository root
```

**Without Docker** — build the panel once; the hub finds it in `panel/dist`:

```bash
cd panel
npm ci
npm run build          # type-checks and builds into panel/dist
cd ../gate && npm start
```

`MINDGATE_PANEL_DIR` points to the panel directory:

| Value | Effect |
|---|---|
| not set | `panel/dist` next to `gate/` (from a checkout), `/app/panel` in the image |
| a path | the panel from that directory |
| empty (`MINDGATE_PANEL_DIR=`) | panel off, only the API remains |

When the directory has no built panel (no `index.html`), the hub **starts normally** and warns in the log: `the admin panel is not built there … /admin/ is off`. `/admin/` then answers `404`; the API works.

## Signing in and the token

You enter the token once on the sign-in screen; the panel checks it against the hub at once (`GET /admin/api/status`), so a wrong token shows immediately.

- By default the token lives **in this tab only** (`sessionStorage`) — closing the tab signs you out.
- "Keep me signed in on this device" stores it in `localStorage`. Do not turn that on on a shared computer.
- If the hub rejects the token (changed, cleared), the panel goes back to the sign-in screen with a message. "Sign out" in the menu removes the token from both places.
- The token is sent only to `/admin/api` at the same address, in the `Authorization` header. The panel files are public and **contain no secrets** — the `/admin/` address reveals nothing, and everything you see after signing in comes from the API.
- Provider keys never come back from the API (only the last characters show). A client's full key is shown **once**, in the window after it is created — it cannot be read later.

## Screens

| Menu | What is there |
|---|---|
| **Overview** | the state of providers (online / asleep / waking, queue "running / waiting", the last problem), today's numbers (requests, tokens, errors, the share of tokens served on your own hardware), a 14-day chart, recent errors |
| **Providers** | adding from presets (OpenRouter, Gemini, Anthropic, a machine with an agent…), editing, connection test, model list sync, enabling / disabling, waking a machine, deleting |
| **Models** | everything the hub can serve: search and filters (provider, kind, where it runs, state, tag), enabling one by one or in bulk, editing the name / tags / context / capabilities, adding a model by hand |
| **Client keys** | creating, limits (requests per minute / day, tokens per day / month), priority range, "local only", allowed models, usage against limits, revoking and deleting |
| **Usage** | 7 / 30 / 90 days, requests / tokens / errors, local vs cloud split, tables per model and per key; the key and model filters work in the browser, with no refetch |
| **Request log** | who, which model, how it went, how long it took; details of one request; "Load older"; auto-refresh every 5 s (can be turned off). Never the content of prompts or answers — same as in the hub |

The page address carries the state of the view (`#/usage?days=7&metric=tokens`, `#/log?errors=1&key=…`, `#/models?q=qwen&state=off`), so you can paste a view to someone or return to it with the "back" button.

### Machines with an agent

A provider that has an agent also shows the machine on its own page: the connection, the hardware (CPU, RAM, GPU, disk), the models in GPU memory, the installed models with an estimate of whether they fit in VRAM, downloads with progress and cancelling, loading / unloading / deleting, and shutting down with the reason for a refusal.

The panel **never wakes a machine by itself**. A sleeping machine is shown as sleeping, and its model screen does not query the agent until you wake it with the "Wake up" button — the same as in the hub ([05 - Node protocol](05-nodes.md)). A refused shutdown (someone is working, a download is running, requests are in progress…) is shown with the reason; "Shut down anyway" is a separate, confirmed step.

## Security

The hub serves the panel files only with `GET` and `HEAD`, from its own directory: paths with `..`, hidden files (`.env`, `.git`), directories and links that point outside the panel directory are rejected (`404`). The page gets a restrictive content policy:

```
default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:;
connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

That means no external scripts, fonts or connections (the panel loads nothing from the internet — the fonts are in the bundle), no inline scripts, and no embedding in a frame. Files in `assets/` have a content hash in the name and are cached "forever"; the page itself (`index.html`) is not — after the hub is updated, the browser picks up the new version at once.

Two things do not depend on the panel:

- The admin token travels in a header, so outside your home network use **HTTPS** (nginx / Caddy in front of the hub, `MINDGATE_TRUST_PROXY=true`).
- `/admin` (the panel included) does not have to be visible from the internet — in nginx you can limit it to the local network, as described in [01 - Hub](01-gate.md).

## Developing the panel

The panel is Vite + React + TypeScript in `panel/`, with no external services at run time.

```bash
cd gate && npm run dev                 # hub on :3000
cd panel && npm ci && npm run dev      # panel at http://localhost:5173/admin/, /admin/api goes to the hub
                                       # another hub address: MINDGATE_URL=http://pi.lan:3000 npm run dev
npm test                               # tests (Vitest + Testing Library)
npm run typecheck
npm run build                          # panel/dist
```

Layout: `src/api` (the client and the hub's response types), `src/lib` (state, queries, formatting — no React where possible), `src/ui` (buttons, forms, dialogs, charts), `src/pages` (one file per screen), `src/i18n` (`en.ts` — all user-facing text; a test fails on non-English letters). Colours carry meaning: amber is "runs on your side", steel blue is "runs at the provider", green / yellow / red are state — do not use them as decoration.

## Troubleshooting

**`/admin/` answers 404 and the API works** — the panel is not built (see the warning in the hub's log) or `MINDGATE_PANEL_DIR` is empty. Build `panel/` or use the Docker image.

**The panel asks for sign-in after every tab close** — that is how it works; tick "Keep me signed in on this device".

**The panel returns to sign-in by itself** — the hub rejected the token (a changed `MINDGATE_ADMIN_TOKEN`). Sign in with the new one.

**The panel shows "The hub does not answer"** — the browser cannot reach the hub (network, nginx, wrong port). `GET /health` should work without a token.

**After `docker compose up --build` the image does not build: `COPY panel/…` cannot find the files** — the build context is not the repository root. Use `docker-compose.yml` from `gate/` (it has `context: ..`) or `docker build -f gate/Dockerfile .` from the root.
