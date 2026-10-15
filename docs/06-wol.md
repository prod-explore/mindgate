# Wake-on-LAN — setup

Wake-on-LAN (WoL) lets the hub on the Raspberry Pi start the compute machine remotely when a request with priority ≥ 3 arrives. It needs a one-time setup on the machine and on the router.

---

## 1. The compute machine's BIOS/UEFI

Enter the BIOS (Del / F2 / F12 at startup) and find the Wake-on-LAN option. Its location depends on the board's manufacturer:

- **ASUS**: Advanced → APM Configuration → Power On By PCI-E → **Enabled**
- **Gigabyte**: Settings → IO Ports → Wake on LAN → **Enabled**
- **MSI**: Settings → Advanced → Wake Up Event Setup → Resume By PCI-E Device → **Enabled**
- **ASRock**: Configuration → ACPI Configuration → PCIE Devices Power On → **Enabled**

Save and exit (F10).

---

## 2. Network card — Windows

### Turn on WoL in the driver

1. `Win + X` → Device Manager → Network Adapters
2. Right-click the network card → Properties
3. The **Power Management** tab:
   - ✅ Allow this device to wake the computer
   - ✅ Only allow a magic packet to wake the computer
4. The **Advanced** tab → find **Wake on Magic Packet** → set it to **Enabled**

### Turn off Fast Startup (important!)

Fast Startup in Windows can block WoL after a shutdown:

`Control Panel → System and Security → Power Options → Choose what the power buttons do → Turn off fast startup`

Or through PowerShell (as administrator):

```powershell
powercfg /hibernate off
```

### Check that WoL survives a shutdown

After the computer is shut down, the network card's activity light should still glow (faintly). If it goes out completely, WoL is not enabled in the BIOS.

---

## 3. Network card — Linux

```bash
# Check the current WoL state
sudo ethtool eth0 | grep -i wake

# Turn WoL on (temporarily, until a restart)
sudo ethtool -s eth0 wol g

# Check the interface name
ip link show
```

### Making it permanent — systemd

Create `/etc/systemd/system/wol.service`:

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

### Making it permanent — NetworkManager

```bash
# Find the connection name
nmcli connection show

# Turn WoL on
nmcli connection modify "Wired connection 1" 802-3-ethernet.wake-on-lan magic

# Apply
nmcli connection up "Wired connection 1"
```

---

## 4. Router — a fixed IP for the machine

The WoL magic packet is sent to a specific MAC address. For the hub to always know where to send it, the compute machine should have a fixed (reserved) IP address.

In the router's panel (usually 192.168.1.1 or 192.168.0.1):

1. Find the **DHCP** section → **DHCP Reservations** (or Static Leases, Address Reservation)
2. Find the compute machine in the list of devices
3. Give it a fixed IP, for example `192.168.1.100`
4. Save and restart the router

---

## 5. Find the machine's MAC address

**Windows:**
```cmd
ipconfig /all
```
Look for "Physical Address" next to the Ethernet card.

**Linux:**
```bash
ip link show eth0
# or
cat /sys/class/net/eth0/address
```

A MAC looks like this: `AA:BB:CC:DD:EE:FF`

---

## 6. Enter the data in the hub

To the hub, the machine is a provider with the `node` setting. Set it in the panel (Providers → the machine) or through the administrator API:

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

- `broadcast` — the network's broadcast address. For a `192.168.1.x` network with a `/24` mask it is `192.168.1.255`; it can also be `255.255.255.255` if the router lets it through.
- **Hub in Docker (bridge):** broadcast usually does not cross the bridge. Put **the machine's IP address** (unicast) here — the magic packet will reach its card anyway.
- `min_wake_priority` — from which priority a request wakes the machine; weaker ones get `503 node_asleep` (and an alias moves on to the next target).
- `control_url` — the address of the MindGate agent ([02 - Agent](02-agent.md)). The hub derives the other two addresses from it, so you usually enter nothing more. It also gives management of the models on the machine ([05 - Node protocol](05-nodes.md)).
- `health_url` (by default `<control_url>/health`) — an address that answers when the machine is up; the hub checks it when a request hits a machine whose last answer is older than 30 s, and every 30 s in the background. Set it by hand only for a machine without an agent (for example a bare Ollama: `http://192.168.1.100:11434/api/version`).
- `idle_shutdown_minutes` — after this many minutes without requests the hub asks the agent to shut down (by default `<control_url>/node/power/shutdown-request`; your own `shutdown_url` replaces that when you shut the machine down with a script). The agent may refuse (it is working, someone is sitting at the computer) — then the hub asks again only after 5 minutes.

The machine's fixed IP address matters: the provider's `base_url` and `control_url` point to it.

---

## 7. Testing WoL

Shut the compute machine down, then ask the hub to wake it (it waits until the machine answers, and prints the state):

```bash
curl -X POST http://localhost:3000/admin/api/providers/agent/wake \
  -H "Authorization: Bearer <MINDGATE_ADMIN_TOKEN>"
# {"status":"online"}
```

The machine should come up within 5–30 seconds (the hub waits up to `boot_timeout_ms` and repeats the magic packet every 10 s). When it returns `node_unavailable` and the machine does not start, the problem is on the BIOS / network card side (see below), not in the hub. You can also send the packet by hand to rule the hub out:

```bash
# on the Raspberry Pi
sudo apt install wakeonlan
wakeonlan -i 192.168.1.255 AA:BB:CC:DD:EE:FF
```

---

## 8. Troubleshooting

**The machine does not react to the magic packet**

Check in order:
1. BIOS — is WoL enabled?
2. Windows Fast Startup — is it off?
3. The card's driver — is WoL enabled in the driver?
4. Does the network card's light stay on after the shutdown? (standby power)
5. Are you sending to the right MAC and broadcast?

**WoL works once, then stops**

Windows may reset the WoL settings after driver updates. Check Device Manager after every larger update.

**WoL works from the local network but not from outside**

That is a separate topic (WoL over the internet needs UDP port 9 forwarded on the router, or a VPN). In MindGate the hub is on the same network as the machine — local WoL should always work.

**The computer turns on by itself (unwanted wake-ups)**

Set "Wake on LAN" to magic packet only (not "any packet") in the card's driver. Also check the BIOS — turn off "Power On by PCI-E" if it is too sensitive.
