# MHF-Z on Linux, without the launcher

Boot the Monster Hunter Frontier Z client on Ubuntu under plain Wine — no launcher GUI, no
embedded Internet Explorer, no Capcom login servers. Click the desktop icon, and the game goes
straight from splash to the town square.

The trick is that the stock launcher is skipped entirely. Instead of running `mhf.exe`, this
generates the `config.json` that a launcher would have produced and hands it to
[`mhf-iel-cli.exe`](https://github.com/rockisch/mhf-iel), which starts the game from an
already-authenticated session.

> This repository contains **no game files** — no executables, no `dat/`, no Capcom assets or
> text. It is glue code only. You must supply your own client and run your own server.

---

## Why the stock launcher is a dead end

Normally `mhf.exe` loads `mhl.dll`, which renders the launcher UI in an **embedded Internet
Explorer control** and handshakes with Capcom's `sign-mhf.capcom-networks.jp`. Two problems:

1. That endpoint has been dead since the service ended in 2019. Private-server projects such as
   [Erupe](https://github.com/ZeruLight/Erupe) reimplement the game backend, but the client's
   launcher path still expects the original sign-in flow.
2. Even if it answered, an embedded IE control is one of the least pleasant things you can ask
   Wine to render.

So the launcher is not something to fix. It is something to route around.

## How the bypass works

`mhf-iel-cli.exe` (from [rockisch/mhf-iel](https://github.com/rockisch/mhf-iel), "MHF-ZZ custom
launcher without IE") reads a `config.json` from the game folder that describes a session that
has *already* been authenticated, and jumps straight into the client. All this project has to
do is produce that file.

Erupe exposes a plain HTTP API, so a login is one `curl` call, and `to_config_master.py`
reshapes the response:

| `config.json` field | Source |
|---|---|
| `user_token`, `user_token_id`, `user_rights` | the `user` object in the `/v2/login` response |
| `char_id`, `char_name`, `char_hr`, `char_gr` | `characters[MHF_CHAR_INDEX]` |
| `char_ids` | every character id on the account |
| `user_name`, `user_password` | environment (`MHF_USER` / `MHF_PASS`) |
| `server_host`, `server_port` | environment (`MHF_HOST` / `MHF_PORT`), default `127.0.0.1:53310` |
| `entrance_count`, `current_ts`, `expiry_ts`, `notices` | passed through from the response |
| `mez_*` | the `mezFes` object; numeric stall IDs are mapped to the names mhf-iel expects |
| `version` | hardcoded `"ZZ"` |

Tokens are issued fresh on every login and the old ones stop working, so `config.json` is
regenerated on each launch rather than kept around.

## Launch flow

```
  Desktop entry  (~/.local/share/applications/mhf-kaname.desktop)
        │
        ▼
  mhf-launch.sh
        │
        ├─ 1. source ~/.config/mhf-launcher/env      credentials, host, character index
        │
        ├─ 2. systemctl --user start mhf-tunnel      SSH forwards 8080 / 53310 / 53312
        │     └─ poll http://127.0.0.1:8080/v2/health   (up to 20x, 1s apart)
        │
        ├─ 3. wineserver -k                          kill stale processes, then sleep 2
        │
        ├─ 4. POST /v2/login  ──▶  to_config_master.py  ──▶  config.json
        │
        └─ 5. exec wine ./mhf-iel-cli.exe
```

Step 3 is not optional. A leftover `wineserver` from a previous run makes the client die with a
`game global alloc` error.

## Network layout

The setup this was built for runs Erupe on a home server and reaches it over an SSH tunnel, so
every port below is dialed at `127.0.0.1` from the game's point of view.

| Port | Role | Notes |
|---|---|---|
| 8080 | Erupe HTTP API (`/v2/login`, `/v2/health`) | bound to loopback server-side, so the tunnel is the only way in |
| 53310 | Entrance server | **the client hardcodes 127.0.0.1 here**, so it must be forwarded |
| 53312 | Sign server | forwarded alongside |
| 54001+ | Channel servers | dialed directly at whatever IP the Entrance response returns |

Because the client also contacts `alt_ip_address:8080` mid-game (screenshot upload, among other
things), `MHF_HOST` must be an address that actually resolves to a working API from inside the
game — hence `127.0.0.1` when tunnelling. Point it elsewhere only if the API is directly
reachable.

If your server is on the same machine or on an open LAN address, you can drop the tunnel and set
`MHF_HOST` / `MHF_PORT` accordingly.

## Setup

**Requirements**

- Wine (developed against wine-staging 11.x), plain — no Proton, no DXVK flags, no DLL overrides
- `curl`, `python3`, and `zenity` for the error dialog
- Your own copy of the game, plus `mhf-iel-cli.exe` from
  [rockisch/mhf-iel](https://github.com/rockisch/mhf-iel), in a folder named
  `Monster Hunter Frontier Online/` next to `mhf-launch.sh`
- A reachable [Erupe](https://github.com/ZeruLight/Erupe) server
- Optional, for `tools/`: `python-xlib` and `ffmpeg`

**Steps**

```bash
git clone <this repo> mhf-kaname-launcher
cd mhf-kaname-launcher

# game folder goes here (not shipped):
#   ./Monster Hunter Frontier Online/{mhf-iel-cli.exe,mhfo.dll,dat/,...}

mkdir -p ~/.config/mhf-launcher
cp examples/mhf-launcher.env.example ~/.config/mhf-launcher/env
chmod 600 ~/.config/mhf-launcher/env
$EDITOR ~/.config/mhf-launcher/env          # username, password, host

# only if you need the SSH tunnel:
cp examples/mhf-tunnel.service.example ~/.config/systemd/user/mhf-tunnel.service
$EDITOR ~/.config/systemd/user/mhf-tunnel.service    # SERVER_USER@SERVER_HOST
systemctl --user daemon-reload
systemctl --user enable --now mhf-tunnel.service
loginctl enable-linger "$USER"

# desktop integration:
cp examples/mhf-kaname.desktop.example ~/.local/share/applications/mhf-kaname.desktop
$EDITOR ~/.local/share/applications/mhf-kaname.desktop   # absolute paths

./mhf-launch.sh
```

The Wine prefix defaults to `~/.wine-mhf` and the locale is forced to `ja_JP.UTF-8`; both are set
at the top of `mhf-launch.sh`.

## The "connection error" when accepting a quest — it isn't the network

This one cost real debugging time, so here is the full finding.

**Symptom.** The game runs fine, but accepting a quest at the counter hangs and eventually
reports a connection error. It looks exactly like a dead endpoint or a blocked port.

**What we checked.** A winsock trace (`WINEDEBUG=+winsock`) showed connections to 53310 and
54001+ and *nothing else* — no attempts on dead Capcom addresses, no failed connects, no
timeouts at the socket layer. The network was never the problem.

**Actual cause.** The client stops sending keepalive pings as soon as its window loses focus.
Erupe's session reaper sees a silent client and drops the session. The "connection error" is the
server having already hung up. This is stock MHF client behaviour, not a Wine artifact — it just
bites much harder on a desktop where a launcher script, a notification, or a window manager can
steal focus at exactly the wrong moment.

**Fix.** Keep the window focused. For normal play that is all there is to it — with focus held,
the full path (counter → category → quest list → accept → load into the quest → combat) completes
without a hitch. For headless or automated runs, `tools/holdfocus.py` re-raises and re-focuses the
game window once a second for as long as it runs.

## Other Wine notes

- **Run windowed.** In `mhf.ini`, set `FULLSCREEN_MODE=0` and something reasonable for
  `WINDOW_RESOLUTION` (e.g. `1280x800`). Fullscreen tends to come up as a black screen, and
  windowed behaves far better as a desktop application. Back up the original `mhf.ini` first.
- **`wineserver -k` before every launch**, as above.
- No `WINEDLLOVERRIDES` and no DLL patching are needed. If you find a "patched" DLL lying around,
  check whether it actually differs from the original before assuming it matters.

## Helper tools

Not needed for normal play; these exist for automation and debugging on X11.

- `tools/holdfocus.py` — keeps the game window raised and input-focused, once a second, until
  killed. This is the practical answer to the ping/timeout behaviour above.
- `tools/mhfwin.py` — find the game window, screenshot it via `ffmpeg -f x11grab`, or send keys
  and clicks through XTest. `mhfwin.py list | shot <out.png> | focus | key <keysym> | keys <k1,k2,...> | hold <keysym> <ms> | click <x> <y>`.

Both use `python-xlib` and are X11-only.

## Security

- `config.json` holds a live session token **and your account password in plaintext**.
- `logs/login-raw.json` holds the raw login response, token included.

Both are gitignored here. Do not paste either into an issue report without redacting them.

## Scope and legal

No game binaries, assets, configuration, or Capcom-authored text are distributed in this
repository. It is a launcher script and a JSON transform, intended for use with a private server
you operate yourself. Bring your own client.

## Credits

- [Erupe](https://github.com/ZeruLight/Erupe) — the Monster Hunter Frontier server emulator
- [rockisch/mhf-iel](https://github.com/rockisch/mhf-iel) — the IE-free launcher whose CLI build
  makes this whole approach possible
- [GUEVARA1962/mhf-kaname-launcher](https://github.com/GUEVARA1962/mhf-kaname-launcher) — as well as this being a direct fork from it, though not directly utilizing the python code anymore, a lot of the logic is rewritten into typescript/electron code. Without him laying the foundation this would not have been possible.

## License

CUSTOM — see [LICENSE](LICENSE).
