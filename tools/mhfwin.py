#!/usr/bin/env python3
"""MHF window helper: find window / screenshot / send keys via XTest.

Usage:
  mhfwin.py list
  mhfwin.py shot <out.png>          # screenshot of the MHF window (no focus change)
  mhfwin.py focus                   # focus the MHF window
  mhfwin.py key <keysym> [hold_ms]  # press key (focus first); e.g. Return, Up, z, x
  mhfwin.py keys <k1,k2,...> [interval_ms]
  mhfwin.py hold <keysym> <ms>      # hold a key down for ms
  mhfwin.py click <x> <y>           # click at window-relative coords
"""
import sys, os, time, subprocess
from Xlib import display, X, protocol
from Xlib.ext import xtest
from Xlib import XK

d = display.Display()
root = d.screen().root

TARGET_HINTS = ("mhf", "monster hunter", "frontier")

def all_windows():
    out = []
    NET_CLIENT_LIST = d.intern_atom('_NET_CLIENT_LIST')
    NET_WM_NAME = d.intern_atom('_NET_WM_NAME')
    UTF8 = d.intern_atom('UTF8_STRING')
    prop = root.get_full_property(NET_CLIENT_LIST, 0)
    for wid in (prop.value if prop else []):
        w = d.create_resource_object('window', wid)
        try:
            n = w.get_full_property(NET_WM_NAME, UTF8)
            name = n.value.decode('utf-8', 'replace') if n else ''
            if not name:
                nm = w.get_wm_name()
                name = nm if isinstance(nm, str) else (nm.decode('latin-1') if nm else '')
            cls = w.get_wm_class() or ("", "")
            g = w.get_geometry()
            abs_pos = root.translate_coords(w, 0, 0)
            out.append((w, name, cls, g.width, g.height, abs_pos.x, abs_pos.y))
        except Exception:
            continue
    return out

def find_mhf():
    cands = []
    for w, name, cls, width, height, ax, ay in all_windows():
        blob = (str(name) + " " + " ".join(map(str, cls))).lower()
        if any(h in blob for h in TARGET_HINTS) and width >= 300 and height >= 200:
            cands.append((w, name, cls, width, height, ax, ay))
    if not cands:
        return None
    cands.sort(key=lambda c: -(c[3] * c[4]))
    return cands[0]

def focus(w):
    try:
        w.map()
    except Exception:
        pass
    ewmh_activate(w)
    try:
        w.configure(stack_mode=X.Above)
    except Exception:
        pass
    try:
        w.set_input_focus(X.RevertToParent, X.CurrentTime)
    except Exception:
        pass
    d.sync()
    time.sleep(0.2)

def ewmh_activate(w):
    NET_ACTIVE = d.intern_atom('_NET_ACTIVE_WINDOW')
    ev = protocol.event.ClientMessage(window=w, client_type=NET_ACTIVE,
                                      data=(32, [2, X.CurrentTime, 0, 0, 0]))
    root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
    d.flush()

def press(keysym_name, hold_ms=60):
    ks = XK.string_to_keysym(keysym_name)
    if ks == 0:
        print("unknown keysym", keysym_name); sys.exit(1)
    kc = d.keysym_to_keycode(ks)
    xtest.fake_input(d, X.KeyPress, kc)
    d.sync()
    time.sleep(hold_ms / 1000.0)
    xtest.fake_input(d, X.KeyRelease, kc)
    d.sync()

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        for w, name, cls, width, height, ax, ay in all_windows():
            print(hex(w.id), repr(name), cls, f"{width}x{height}+{ax}+{ay}")
        return
    m = find_mhf()
    if not m:
        print("MHF window not found"); sys.exit(2)
    w, name, cls, width, height, ax, ay = m
    if cmd == "shot":
        out = sys.argv[2]
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "x11grab",
                        "-video_size", f"{width}x{height}", "-i", f":0.0+{ax},{ay}",
                        "-frames:v", "1", out], check=True)
        print("shot", out, f"{width}x{height}+{ax}+{ay}")
    elif cmd == "focus":
        focus(w)
        print("focused", repr(name))
    elif cmd == "key":
        focus(w)
        press(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 60)
        print("key", sys.argv[2])
    elif cmd == "keys":
        focus(w)
        interval = float(sys.argv[3]) / 1000.0 if len(sys.argv) > 3 else 0.4
        for k in sys.argv[2].split(","):
            press(k)
            time.sleep(interval)
        print("keys done")
    elif cmd == "hold":
        focus(w)
        press(sys.argv[2], int(sys.argv[3]))
        print("held", sys.argv[2], sys.argv[3])
    elif cmd == "click":
        focus(w)
        x, y = ax + int(sys.argv[2]), ay + int(sys.argv[3])
        xtest.fake_input(d, X.MotionNotify, x=x, y=y)
        d.sync(); time.sleep(0.1)
        xtest.fake_input(d, X.ButtonPress, 1); d.sync(); time.sleep(0.08)
        xtest.fake_input(d, X.ButtonRelease, 1); d.sync()
        print("clicked", x, y)
    else:
        print(__doc__)

main()
