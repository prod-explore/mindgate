# Tray App — mindgate-tray

Aplikacja działająca w zasobniku systemowym (system tray) na maszynie obliczeniowej. Pokazuje status systemu, pozwala ręcznie zarządzać shutdown guard i daje szybki dostęp do logów i kolejki.

Zbudowana w Node.js z biblioteką `node-systray`. Działa na Windows i Linux.

---

## Wymagania

- Node.js 20+
- Windows 10+ lub Linux z DE (GNOME, KDE, XFCE)
- Na Linux: `libappindicator` (większość DE ma domyślnie)

---

## Instalacja

```bash
cd mindgate/tray
npm install
```

### Autostart — Windows

```bash
node scripts/install-autostart-windows.js
```

Skrypt dodaje wpis do `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.

### Autostart — Linux

```bash
cp mindgate-tray.desktop ~/.config/autostart/
```

Plik `mindgate-tray.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=MindGate Tray
Exec=/usr/bin/node /home/twoj-user/mindgate/tray/src/index.js
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
```

---

## Funkcje

### Ikona i status

Ikona w trayu zmienia kolor według stanu systemu:

| Kolor | Stan |
|-------|------|
| 🟢 Zielony | Agent działa, modele gotowe |
| 🟡 Żółty | Przetwarza żądania (kolejka > 0) |
| 🔵 Niebieski | Idle, czeka na żądania |
| 🔴 Czerwony | Błąd — agent nie odpowiada |
| ⚪ Szary | Wyłączony / nie podłączony |

### Menu kontekstowe (prawy klik)

```
MindGate                     ← nazwa + wersja
─────────────────────────────
● Agent: OK  |  Kolejka: 0
  Ostatnie żądanie: 3 min temu
─────────────────────────────
🛡️  Używam PC — NIE wyłączaj  ← toggle
─────────────────────────────
📋  Pokaż kolejkę
📊  Statystyki
📜  Logi
─────────────────────────────
⚙️  Ustawienia
🔄  Restart agenta
⏹️  Zatrzymaj agenta
─────────────────────────────
✕  Zamknij tray
```

### "Używam PC — nie wyłączaj"

Najważniejsza funkcja. Gdy ją włączysz (toggle), system **nigdy** nie wyśle sygnału shutdown, nawet jeśli nie ma żądań przez długi czas.

Włącz gdy:
- Instalujesz coś dużego i nie chcesz żeby system się wyłączył w środku
- Słuchasz muzyki (Spotify, inne)
- Pracujesz lokalnie i nie chcesz przerw

Toggle jest widoczny w menu jako pierwsza opcja — jeden klik.

---

## Logika shutdown guard

Wyłączenie zaczyna się w hubie: po `idle_shutdown_minutes` bez żądań prosi agenta (`POST /node/power/shutdown-request`). Agent sprawdza po swojej stronie, a potem pyta tray (`POST /shutdown-check`):

```
Agent (sam):
  1. Trwa żądanie /v1 albo pobieranie modelu?  → NIE (requests_in_flight / download_in_progress)
Tray (na prośbę agenta):
  2. Czy toggle "Używam PC" jest włączony?     → NIE (user_toggle_active)
  3. Czy minęło X sekund od ostatniego inputu? → jeśli nie → NIE (user_recently_active)
  4. (planowane) czy działają procesy z whitelisty?
```

Werdykt traya jest ostateczny. Jeśli tray nie odpowiada (nie działa, zawieszony), agent odmawia (`tray_unreachable`): komputera, przy którym może siedzieć człowiek, nie wyłącza się „na zgadywanie”. Na serwerze bez traya (`MINDGATE_TRAY_URL=` puste w `agent/.env`) agent decyduje sam. Tylko gdy wszystkie warunki są spełnione, agent uruchamia `shutdown` z opóźnieniem (`MINDGATE_SHUTDOWN_DELAY_SECONDS`, domyślnie 30 s). Gdy agent pracuje (żądanie w toku albo pobieranie), tray dodatkowo blokuje na Windows ręczne wyłączenie systemu z menu Start — Windows pokaże, że MindGate przetwarza żądania.

### Sprawdzanie aktywności użytkownika

**Windows** — WinAPI `GetLastInputInfo`:

```javascript
// Użycie node-ffi-napi lub node-addon-api
import { getLastInputTime } from './idle-windows.js'

const secondsIdle = getLastInputTime()  // sekundy od ostatniego ruchu myszy/klawiatury
```

**Linux** — `xprintidle` lub `/proc/interrupts`:

```javascript
import { execSync } from 'child_process'

function getIdleSeconds() {
  try {
    const ms = parseInt(execSync('xprintidle').toString().trim())
    return Math.floor(ms / 1000)
  } catch {
    return 0  // jeśli nie można sprawdzić, zakładaj aktywność
  }
}
```

### Whitelist procesów (planowane)

Blokowanie wyłączenia, gdy działa wskazany program (odtwarzacz, instalator, przeglądarka), nie jest jeszcze zaimplementowane. Dziś o wyłączeniu decydują: toggle „Używam PC”, czas od ostatniego inputu i to, czy agent pracuje.

```yaml
# tray/config/tray.yml
shutdown_guard:
  idle_threshold_seconds: 120     # 2 minuty braku inputu = "nieaktywny"
  respect_manual_boot: true
```

---

## IPC z agentem

Tray i agent rozmawiają przez HTTP na localhost. Ścieżki agenta wymagają `Authorization: Bearer <MINDGATE_NODE_SECRET>`; tray bierze ten sam sekret z `agent.secret` w `tray.yml` (albo ze zmiennej środowiskowej `MINDGATE_NODE_SECRET`).

```
Agent  →  POST http://127.0.0.1:3002/shutdown-check  →  Tray   { idle_minutes }  →  { allow, reason }
Tray   →  GET  <agent>/health                         (co 5 s: stan, ikona, `in_flight` + `downloads` = „zajęty”)
Tray   →  POST <agent>/node/user-active               (co 5 s i przy zmianie toggla: { active, last_input_seconds_ago })
Tray   →  POST <agent>/node/exit                      (menu „Zamknij tray”: agent kończy pracę)
```

Mini-serwer traya (port 3002, tylko `127.0.0.1`) udostępnia też `GET /status` (`user_toggle_active`, `idle_seconds`).

Pełny kontrakt agenta: [05 - Węzły](05-nodes.md). Test w repozytorium (`e2e/`) sprawdza, że każda ścieżka, którą woła tray, istnieje w agencie.

---

## Struktura kodu

```
tray/src/
├── index.js          Główna pętla, inicjalizacja systray
├── menu.js           Budowanie i aktualizacja menu trayu
├── ipc.js            Komunikacja HTTP z agentem
├── idle.js           Sprawdzanie aktywności użytkownika
├── shutdown-block.js Blokada ręcznego wyłączenia Windows, gdy agent pracuje
├── icons/
│   ├── green.ico
│   ├── yellow.ico
│   ├── blue.ico
│   ├── red.ico
│   └── gray.ico
└── config.js         Ładowanie tray.yml
```

---

## Budowanie binarki (opcjonalnie)

Jeśli chcesz jedną binarką zamiast `node src/index.js`:

```bash
npm install -g pkg
pkg src/index.js --targets node20-win-x64,node20-linux-x64 --output dist/mindgate-tray
```

Wynik: `dist/mindgate-tray.exe` (Windows) i `dist/mindgate-tray` (Linux).

---

## Troubleshooting

**Ikona nie pojawia się w trayu (Linux)**
Zainstaluj `libappindicator3-1`:
```bash
sudo apt install libappindicator3-1
```
Na GNOME może być potrzebne rozszerzenie "AppIndicator and KStatusNotifierItem Support".

**WinAPI nie działa (idle detection na Windows)**
Upewnij się że `node-ffi-napi` jest zainstalowane i skompilowane:
```bash
npm install node-ffi-napi
npm rebuild
```

**Toggle "Używam PC" resetuje się po restarcie**
Celowe zachowanie — po każdym starcie systemu zakładamy że komputer może być wyłączony zdalnie. Włącz ręcznie gdy potrzebujesz.
