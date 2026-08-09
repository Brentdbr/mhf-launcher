"""Turn an Erupe POST /v2/login response into the config.json that mhf-iel-cli.exe expects.

Reads the raw login JSON on stdin, writes config.json on stdout.
Credentials and server address come from the environment (see
examples/mhf-launcher.env.example).
"""
import json, sys, os

# MezFes stall IDs -> the names mhf-iel expects.
STALLS = {5:"GoocooScoop", 2:"TokotokoPartnya", 3:"Pachinko", 4:"VolpakkunTogether",
          6:"Nyanrendo", 7:"HoneyPanic",
          8:"DokkanBattleCats", 9:"PointStall", 10:"StallMap"}

a = json.load(sys.stdin)
chars = a.get("characters") or []
sel = int(os.environ.get("MHF_CHAR_INDEX", "0"))
ch = chars[sel] if chars else None
mez = a.get("mezFes") or {}

json.dump({
  "char_id":   ch["id"]   if ch else 0,
  "char_name": ch["name"] if ch else "",
  "char_hr":   ch["hr"]   if ch else 0,
  "char_gr":   ch["gr"]   if ch else 0,
  "char_ids":  [c["id"] for c in chars],
  "char_new":  False,
  "user_token_id": a["user"]["tokenId"],
  "user_token":    a["user"]["token"],
  "user_name":     os.environ["MHF_USER"],
  "user_password": os.environ["MHF_PASS"],
  "user_rights":   a["user"]["rights"],
  "server_host":   os.environ.get("MHF_HOST", "127.0.0.1"),
  "server_port":   int(os.environ.get("MHF_PORT", "53310")),
  "entrance_count": a["entranceCount"],
  "current_ts": a["currentTs"],
  "expiry_ts":  a["expiryTs"],
  "notices": [{"data": n, "flags": 0} for n in a.get("notices", [])],
  "mez_event_id":      mez.get("id", 0),
  "mez_start":         mez.get("start", 0),
  "mez_end":           mez.get("end", 0),
  "mez_solo_tickets":  mez.get("soloTickets", 0),
  "mez_group_tickets": mez.get("groupTickets", 0),
  "version": "ZZ",
  "mez_stalls": [STALLS[s] for s in mez.get("stalls", []) if s in STALLS],
}, sys.stdout, indent=2, ensure_ascii=False)
