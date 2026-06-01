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

Tray app odpowiada na `POST /internal/shutdown-request` od agenta. Zanim pozwoli na shutdown, sprawdza kilka warunków:

```
1. Czy toggle "Używam PC" jest włączony?  → NIE shutdown
2. Czy kolejka agenta jest pusta?          → jeśli nie → NIE shutdown
3. Czy minęło X minut od ostatniego inputu? (WinAPI / X11)
4. Czy działają procesy z whitelisty?
5. Czy użytkownik sam włączył komputer (nie przez WoL)?
```

Tylko gdy wszystkie warunki są spełnione — tray odpowiada agentowi że można wyłączyć, a agent wykonuje `shutdown`.

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

### Whitelist procesów

Procesy które blokują shutdown (konfigurowalne):

```yaml
# tray/config/tray.yml
shutdown_guard:
  idle_threshold_seconds: 120     # 2 minuty braku inputu = "nieaktywny"
  whitelist_processes:
    - "Spotify.exe"
    - "spotify"
    - "vlc"
    - "mpv"
    - "chrome"                    # usuń jeśli nie chcesz blokować przez przeglądarkę
    - "setup.exe"
    - "install"
    - "apt"
    - "apt-get"
    - "winget"

  # Czy komputer był uruchomiony przez WoL (automatycznie)?
  # Jeśli tak — można wyłączyć gdy idle
  # Jeśli nie (user sam włączył) — nie wyłączaj bez wyraźnej zgody
  respect_manual_boot: true
```

Sprawdzanie whitelisty (Windows):

```javascript
import { execSync } from 'child_process'

function isWhitelistProcessRunning(whitelist) {
  const processes = execSync('tasklist /fo csv /nh')
    .toString()
    .toLowerCase()
  return whitelist.some(p => processes.includes(p.toLowerCase()))
}
```

---

## IPC z agentem

Tray app komunikuje się z agentem przez HTTP na localhost:

```
Agent  →  POST /internal/shutdown-request  →  Tray
Tray   →  GET  /internal/status            →  Agent  (polling co 5s)
Tray   →  POST /internal/set-user-active   →  Agent  (gdy toggle zmieniony)
```

Tray ma własny mini-serwer HTTP na porcie 3002 (tylko localhost):

```
POST http://localhost:3002/shutdown-response
  { "allow": false, "reason": "user_toggle_active" }
```

---

## Struktura kodu

```
tray/src/
├── index.js          Główna pętla, inicjalizacja systray
├── menu.js           Budowanie i aktualizacja menu trayu
├── ipc.js            Komunikacja HTTP z agentem
├── idle.js           Sprawdzanie aktywności użytkownika
├── processes.js      Whitelist procesów
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
