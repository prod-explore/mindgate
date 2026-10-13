# Wake on LAN — konfiguracja

Wake on LAN (WoL) pozwala hubowi na Raspberry Pi zdalnie uruchomić maszynę obliczeniową gdy przychodzi żądanie z priorytetem ≥ 3. Wymaga jednorazowej konfiguracji po stronie maszyny i routera.

---

## 1. BIOS/UEFI maszyny obliczeniowej

Wejdź do BIOS (Del / F2 / F12 przy starcie) i znajdź opcję Wake on LAN. Lokalizacja zależy od producenta płyty:

- **ASUS**: Advanced → APM Configuration → Power On By PCI-E → **Enabled**
- **Gigabyte**: Settings → IO Ports → Wake on LAN → **Enabled**
- **MSI**: Settings → Advanced → Wake Up Event Setup → Resume By PCI-E Device → **Enabled**
- **ASRock**: Configuration → ACPI Configuration → PCIE Devices Power On → **Enabled**

Zapisz i wyjdź (F10).

---

## 2. Karta sieciowa — Windows

### Włącz WoL w sterowniku

1. `Win + X` → Device Manager → Network Adapters
2. Kliknij prawym na kartę sieciową → Properties
3. Zakładka **Power Management**:
   - ✅ Allow this device to wake the computer
   - ✅ Only allow a magic packet to wake the computer
4. Zakładka **Advanced** → znajdź **Wake on Magic Packet** → ustaw **Enabled**

### Wyłącz Fast Startup (ważne!)

Fast Startup (szybkie uruchamianie) w Windows może blokować WoL po shutdown:

`Panel sterowania → System i zabezpieczenia → Opcje zasilania → Wybierz działanie przycisków zasilania → Wyłącz szybkie uruchamianie`

Lub przez PowerShell (jako administrator):

```powershell
powercfg /hibernate off
```

### Sprawdź że WoL przeżywa shutdown

Po wyłączeniu komputera, dioda aktywności karty sieciowej powinna nadal świecić (słabo). Jeśli gaśnie całkowicie — WoL w BIOS nie jest włączony.

---

## 3. Karta sieciowa — Linux

```bash
# Sprawdź aktualny stan WoL
sudo ethtool eth0 | grep -i wake

# Włącz WoL (tymczasowo, do restartu)
sudo ethtool -s eth0 wol g

# Sprawdź nazwę interfejsu
ip link show
```

### Trwałe włączenie WoL — systemd

Utwórz `/etc/systemd/system/wol.service`:

```ini
[Unit]
Description=Enable Wake-on-LAN
After=network.target

[Service]
Type=oneshot
ExecStart=/sbin/ethtool -s eth0 wol g
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable wol
sudo systemctl start wol
```

### Trwałe włączenie — NetworkManager

```bash
# Znajdź nazwę połączenia
nmcli connection show

# Włącz WoL
nmcli connection modify "Wired connection 1" 802-3-ethernet.wake-on-lan magic

# Zastosuj
nmcli connection up "Wired connection 1"
```

---

## 4. Router — stały IP dla maszyny

WoL magic packet wysyłany jest na konkretny MAC adres. Żeby hub zawsze wiedział gdzie wysłać packet, maszyna obliczeniowa powinna mieć stały (zarezerwowany) adres IP.

W panelu routera (zwykle 192.168.1.1 lub 192.168.0.1):

1. Znajdź sekcję **DHCP** → **DHCP Reservations** (lub Static Leases, Address Reservation)
2. Znajdź maszynę obliczeniową na liście urządzeń
3. Przypisz jej stały IP, np. `192.168.1.100`
4. Zapisz i zrestartuj router

---

## 5. Znajdź MAC adres maszyny

**Windows:**
```cmd
ipconfig /all
```
Szukaj "Physical Address" przy karcie Ethernet.

**Linux:**
```bash
ip link show eth0
# lub
cat /sys/class/net/eth0/address
```

MAC wygląda tak: `AA:BB:CC:DD:EE:FF`

---

## 6. Wpisz dane do huba

Maszyna jest dla huba dostawcą z ustawieniem `node`. Przy migracji ze starego `config.yml` robi to `import-legacy` (zob. [01 - Hub](01-gate.md)). Ręcznie, przez API administratora:

```bash
curl -X PATCH http://localhost:3000/admin/api/providers/agent \
  -H "Authorization: Bearer <MINDGATE_ADMIN_TOKEN>" -H 'Content-Type: application/json' -d '{
  "node": {
    "mac": "AA:BB:CC:DD:EE:FF",
    "broadcast": "192.168.1.255",
    "port": 9,
    "min_wake_priority": 3,
    "boot_timeout_ms": 120000,
    "poll_interval_ms": 2000,
    "control_url": "http://192.168.1.100:3001",
    "idle_shutdown_minutes": 15
  }
}'
```

- `broadcast` — adres broadcast sieci. Dla sieci `192.168.1.x` z maską `/24` to `192.168.1.255`; może być też `255.255.255.255`, jeśli router to przepuszcza.
- **Hub w Dockerze (mostek):** broadcast zwykle nie przechodzi przez mostek. Wpisz tu **adres IP maszyny** (unicast) — magic packet i tak trafi na jej kartę.
- `min_wake_priority` — od jakiego priorytetu żądanie budzi maszynę; słabsze dostają `503 node_asleep` (a alias przechodzi na kolejny cel).
- `control_url` — adres agenta MindGate ([02 - Agent](02-agent.md)). Z niego hub wyprowadza dwa pozostałe adresy, więc zwykle nic więcej nie wpisujesz. Daje też zarządzanie modelami na maszynie ([05 - Węzły](05-nodes.md)).
- `health_url` (domyślnie `<control_url>/health`) — adres, który odpowiada, gdy maszyna działa; hub sprawdza go, gdy żądanie trafia na maszynę, której ostatnia odpowiedź jest starsza niż 30 s, oraz co 30 s w tle. Ustaw ręcznie tylko dla maszyny bez agenta (np. czysta Ollama: `http://192.168.1.100:11434/api/version`).
- `idle_shutdown_minutes` — po tylu minutach bez żądań hub prosi agenta o wyłączenie (domyślnie `<control_url>/node/power/shutdown-request`; własny `shutdown_url` zastępuje to, gdy wyłączasz maszynę skryptem). Agent może odmówić (pracuje, ktoś siedzi przy komputerze) — wtedy hub pyta ponownie dopiero za 5 minut.

Stały adres IP maszyny jest ważny: `base_url` dostawcy i `control_url` wskazują na nią.

---

## 7. Test WoL

Wyłącz maszynę obliczeniową, a potem poproś hub o jej obudzenie (czeka, aż maszyna odpowie, i wypisuje stan):

```bash
curl -X POST http://localhost:3000/admin/api/providers/agent/wake \
  -H "Authorization: Bearer <MINDGATE_ADMIN_TOKEN>"
# {"status":"online"}
```

Maszyna powinna wstać w ciągu 5–30 sekund (hub czeka do `boot_timeout_ms` i powtarza magic packet co 10 s). Gdy zwróci `node_unavailable`, a maszyna się nie uruchamia — to problem po stronie BIOS / karty sieciowej (zob. niżej), nie huba. Pakiet można też wysłać ręcznie, żeby wykluczyć hub:

```bash
# na Raspberry Pi
sudo apt install wakeonlan
wakeonlan -i 192.168.1.255 AA:BB:CC:DD:EE:FF
```

---

## 8. Troubleshooting

**Maszyna nie reaguje na magic packet**

Sprawdź w kolejności:
1. BIOS — czy WoL jest włączony?
2. Windows Fast Startup — czy wyłączony?
3. Sterownik karty — czy WoL w sterowniku włączony?
4. Czy dioda karty sieciowej świeci po wyłączeniu? (zasilanie standby)
5. Czy wysyłasz na właściwy MAC i broadcast?

**WoL działa raz, potem przestaje**

Windows może resetować ustawienia WoL po aktualizacjach sterowników. Sprawdź Device Manager po każdej większej aktualizacji.

**WoL działa z sieci lokalnej ale nie z zewnątrz**

To osobny temat (WoL przez internet wymaga przekierowania portów UDP 9 na router lub VPN). W MindGate hub jest w tej samej sieci co maszyna — WoL lokalny zawsze powinien działać.

**Komputer się włącza sam (niechciane budzenie)**

Wyłącz "Wake on LAN" tylko dla magic packet (nie dla "any packet") w sterowniku karty. Sprawdź też BIOS — wyłącz "Power On by PCI-E" jeśli jest zbyt czuły.
