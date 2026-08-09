#!/usr/bin/env python3
"""Continuously keep the MHF window foregrounded + input-focused.
Prevents the client from pausing pings (which causes the 60s session timeout).
Runs until killed."""
import time
from Xlib import display, X, protocol

d = display.Display()
root = d.screen().root
NET_ACTIVE = d.intern_atom('_NET_ACTIVE_WINDOW')
NET_CLIENT_LIST = d.intern_atom('_NET_CLIENT_LIST')
NET_WM_NAME = d.intern_atom('_NET_WM_NAME')
UTF8 = d.intern_atom('UTF8_STRING')

def find():
    prop = root.get_full_property(NET_CLIENT_LIST, 0)
    for wid in (prop.value if prop else []):
        w = d.create_resource_object('window', wid)
        try:
            n = w.get_full_property(NET_WM_NAME, UTF8)
            name = n.value.decode('utf-8', 'replace') if n else ''
            if not name:
                nm = w.get_wm_name(); name = nm if isinstance(nm, str) else ''
            if 'MONSTER HUNTER' in name.upper():
                return w
        except Exception:
            continue
    return None

while True:
    w = find()
    if w:
        try:
            w.map()
            ev = protocol.event.ClientMessage(window=w, client_type=NET_ACTIVE,
                                              data=(32, [2, X.CurrentTime, 0, 0, 0]))
            root.send_event(ev, event_mask=X.SubstructureRedirectMask | X.SubstructureNotifyMask)
            w.configure(stack_mode=X.Above)
            w.set_input_focus(X.RevertToParent, X.CurrentTime)
            d.sync()
        except Exception:
            pass
    time.sleep(1.0)
