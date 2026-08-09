#!/usr/bin/env bash
# MHF-Z launcher for Linux/Wine: tunnel check -> /v2/login -> config.json -> wine
#
# Boots the game client directly, without ever running the stock launcher
# (mhf.exe / mhl.dll). See README.md for how and why.
#
# NOTE: this writes logs/login-raw.json, which contains a live session token.
# That is why logs/ is gitignored. Do not share those files.
set -u

BASE="$(cd "$(dirname "$0")" && pwd)"
GAME_DIR="$BASE/Monster Hunter Frontier Online"
LOG_DIR="$BASE/logs"
ENV_FILE="$HOME/.config/mhf-launcher/env"
export WINEPREFIX="$HOME/.wine-mhf"
export LANG=ja_JP.UTF-8

mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/launch-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

fail() {
    echo "ERROR: $1"
    if [ -z "${MHF_NO_GUI:-}" ] && command -v zenity >/dev/null && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
        zenity --error --title="MHF Launcher" --text="$1\n\nLog: $LOG" 2>/dev/null
    fi
    exit 1
}

echo "=== MHF launch $(date) ==="

# 1. credentials
[ -f "$ENV_FILE" ] || fail "Credentials file not found: $ENV_FILE\n\nCopy examples/mhf-launcher.env.example there and fill it in."
# shellcheck source=/dev/null
. "$ENV_FILE"
export MHF_USER MHF_PASS MHF_HOST MHF_PORT MHF_CHAR_INDEX

# 2. tunnel (systemd user service). Start it if needed, then wait for port 8080.
systemctl --user start mhf-tunnel.service 2>/dev/null
ok=""
for i in $(seq 1 20); do
    if curl -sf -m 2 http://127.0.0.1:8080/v2/health >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
done
[ -n "$ok" ] || fail "Could not establish the tunnel to the server (port 8080).\nCheck: systemctl --user status mhf-tunnel.service"
echo "tunnel: ok"

# 3. Clear stale processes. A leftover wineserver from a previous run makes the
#    client die with a 'game global alloc' error.
echo "cleaning stale wine processes..."
wineserver -k 2>/dev/null
sleep 2

# 4. login -> config.json. A fresh token is issued every login; old ones are dead.
RAW="$LOG_DIR/login-raw.json"
curl -sf -m 10 -X POST http://127.0.0.1:8080/v2/login \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$MHF_USER\",\"password\":\"$MHF_PASS\"}" > "$RAW" \
    || fail "Request to /v2/login failed"
python3 -c "import json,sys; d=json.load(open('$RAW')); sys.exit(0 if 'user' in d else 1)" \
    || fail "Malformed login response (check username/password): $(head -c 200 "$RAW")"
python3 "$BASE/to_config_master.py" < "$RAW" > "$GAME_DIR/config.json" \
    || fail "Failed to generate config.json"
python3 -c "
import json; d=json.load(open('$GAME_DIR/config.json'))
print('char=%s id=%d token_id=%d host=%s:%d' % (d['char_name'], d['char_id'], d['user_token_id'], d['server_host'], d['server_port']))
"

# 5. launch
cd "$GAME_DIR" || fail "Game folder not found: $GAME_DIR"
echo "launching wine mhf-iel-cli.exe ..."
exec wine ./mhf-iel-cli.exe
