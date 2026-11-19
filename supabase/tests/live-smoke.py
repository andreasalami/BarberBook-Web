"""Live smoke test of the REST contract the app relies on, against the real Supabase project.

Needs the PROVA2 test shop (supabase/tests/seed-test-shop.sql) and anonymous sign-ins enabled.
Creates two anonymous users and deletes both at the end (delete_me). Prints statuses only, never tokens.
Run with Apple's Python (has system certificates): /usr/bin/python3 -I supabase/tests/live-smoke.py
"""
import json, urllib.request, urllib.error, uuid

BASE = "https://mhhajacrybeuqilyqjhe.supabase.co"
KEY = "sb_publishable_cBO7CrIDzOwU73x24i3wMA_cPRk0hYv"

def call(method, path, body=None, token=None, prefer=None):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode())
    req.add_header("apikey", KEY)
    req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", "Bearer " + token)
    if prefer: req.add_header("Prefer", prefer)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw[:200]

def check(label, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + label + (f"  [{detail}]" if detail and not ok else ""))
    return ok

s, sess = call("POST", "/auth/v1/signup", {})
check("anonymous signup", s == 200 and "access_token" in sess, f"{s} {sess}")
tok = sess["access_token"]
check("session shape (expires_at, refresh_token, user.id, user.is_anonymous)",
      all(k in sess for k in ("expires_at", "refresh_token")) and sess["user"].get("is_anonymous") is True)

s, r = call("POST", "/auth/v1/token?grant_type=refresh_token", {"refresh_token": sess["refresh_token"]})
check("refresh token", s == 200 and "access_token" in r, f"{s} {r}")
tok = r["access_token"]

s, r = call("GET", "/rest/v1/shops?select=*", token=tok)
check("read shops as anonymous", s == 200 and isinstance(r, list), f"{s} {r}")

s, r = call("GET", "/rest/v1/shops?select=code")  # no session: anon role may browse the catalogue (since 20261118120000)
check("keyless catalogue read allowed", s == 200 and isinstance(r, list), f"{s} {r}")
s, r = call("GET", "/rest/v1/bookings?select=*")
check("keyless bookings read refused", s in (401, 403), f"{s} {r}")

s, r = call("POST", "/rest/v1/shops", {"name": "Fake", "week": [None] * 7}, token=tok, prefer="return=representation")
check("anonymous cannot create shop (42501)", s in (401, 403) and isinstance(r, dict) and r.get("code") == "42501", f"{s} {r}")

s, r = call("POST", "/rest/v1/rpc/busy", {"p_staff": str(uuid.uuid4()), "p_from": "2026-11-17T00:00:00Z", "p_to": "2026-11-18T00:00:00Z"}, token=tok)
check("busy() callable, empty", s == 200 and r == [], f"{s} {r}")

s, r = call("GET", "/rest/v1/bookings?select=*,shops(name),staff(name)&order=starts_at", token=tok)
check("bookings select with embedded shops/staff", s == 200 and r == [], f"{s} {r}")


# Two anonymous customers on the PROVA2 test shop.
s, sess2 = call("POST", "/auth/v1/signup", {}); tok2 = sess2["access_token"]
s, shops = call("GET", "/rest/v1/shops?select=*&code=eq.PROVA2", token=tok)
check("open shop by code PROVA2", s == 200 and len(shops) == 1 and shops[0]["name"] == "Barberia di Prova", f"{s} {shops}")
shop = shops[0]
check("owner_id equals the synthetic owner", shop.get("owner_id") == "e0000000-0000-4000-8000-00000000000e")
s, staff = call("GET", f"/rest/v1/staff?select=*&shop_id=eq.{shop['id']}&order=name", token=tok)
check("staff list", s == 200 and [x["name"] for x in staff] == ["Luca", "Marco"], f"{s} {staff}")
import datetime as dt
from zoneinfo import ZoneInfo
# PROVA2 is open Tuesday-Saturday 09:00-19:00 (Rome), and the server refuses bookings outside opening hours.
day = dt.date.today() + dt.timedelta(days=3)
while day.weekday() in (0, 6): day += dt.timedelta(days=1)  # skip Monday and Sunday
start = dt.datetime.combine(day, dt.time(10), ZoneInfo("Europe/Rome")).astimezone(dt.timezone.utc)
end = start + dt.timedelta(minutes=30)
iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
row = {"shop_id": shop["id"], "staff_id": staff[0]["id"], "service_name": "Taglio", "customer_name": "Prova", "starts_at": iso(start), "ends_at": iso(end)}
s, r = call("POST", "/rest/v1/bookings", row, token=tok, prefer="return=representation")
check("customer 1 books", s == 201 and len(r) == 1, f"{s} {r}")
booking_id = r[0]["id"] if s == 201 else None
s, r = call("GET", "/rest/v1/bookings?select=*", token=tok2)
check("customer 2 sees no bookings", s == 200 and r == [], f"{s} {r}")
s, r = call("POST", "/rest/v1/rpc/busy", {"p_staff": staff[0]["id"], "p_from": iso(start - dt.timedelta(hours=9)), "p_to": iso(start + dt.timedelta(hours=15))}, token=tok2)
check("customer 2 sees one busy interval, no names", s == 200 and len(r) == 1 and set(r[0]) == {"starts_at", "ends_at"}, f"{s} {r}")
row2 = dict(row, customer_name="Altro")  # same staff, same time
s, r = call("POST", "/rest/v1/bookings", row2, token=tok2, prefer="return=representation")
check("overlap refused with 23P01 (HTTP 400)", s == 400 and r.get("code") == "23P01", f"{s} {r}")
off = dict(row, customer_name="Altro", starts_at=iso(start + dt.timedelta(hours=1, minutes=15)), ends_at=iso(end + dt.timedelta(hours=1, minutes=15)))
s, r = call("POST", "/rest/v1/bookings", off, token=tok2, prefer="return=representation")
check("start off the 30-minute grid refused with 23514", s == 400 and r.get("code") == "23514" and "mezz" in r.get("message", ""), f"{s} {r}")
s, services = call("GET", f"/rest/v1/services?select=id,minutes&shop_id=eq.{shop['id']}", token=tok2)
check("services on the 30-minute grid", s == 200 and services and all(x["minutes"] % 30 == 0 for x in services), f"{s} {services}")
s, r = call("POST", "/rest/v1/rpc/free_slots", {"p_staff": staff[0]["id"], "p_service": services[0]["id"], "p_day": day.isoformat()})
check("free_slots without login, every 30 minutes", s == 200 and r and all(x[14:16] in ("00", "30") for x in r), f"{s} {r}")
late = dict(row, starts_at=iso(start + dt.timedelta(hours=10)), ends_at=iso(end + dt.timedelta(hours=10)))  # 20:00, closed
s, r = call("POST", "/rest/v1/bookings", late, token=tok2, prefer="return=representation")
check("after closing refused with 23514 and an Italian message", s == 400 and r.get("code") == "23514" and r.get("message", "").startswith("Il negozio è chiuso"), f"{s} {r}")
s, r = call("DELETE", f"/rest/v1/bookings?id=eq.{booking_id}", token=tok2, prefer="return=representation")
check("customer 2 cannot cancel customer 1", s == 200 and r == [], f"{s} {r}")
s, r = call("GET", "/rest/v1/bookings?select=*,shops(name),staff(name)&order=starts_at&starts_at=gte." + iso(dt.datetime.now(dt.timezone.utc)).replace("+", "%2B"), token=tok)
check("customer 1 my bookings with embedded names", s == 200 and len(r) == 1 and r[0]["shops"]["name"] == "Barberia di Prova" and r[0]["staff"]["name"] == "Luca", f"{s} {r}")
s, r = call("DELETE", f"/rest/v1/bookings?id=eq.{booking_id}", token=tok, prefer="return=representation")
check("customer 1 cancels own booking", s == 200 and len(r) == 1, f"{s} {r}")
s, r = call("POST", "/rest/v1/staff", {"shop_id": shop["id"], "name": "Intruso"}, token=tok, prefer="return=representation")
check("customer cannot add staff (42501)", s in (401, 403) and r.get("code") == "42501", f"{s} {r}")
s, r = call("POST", "/rest/v1/rpc/delete_me", {}, token=tok2)
check("delete customer 2", s in (200, 204), f"{s} {r}")

s, r = call("POST", "/rest/v1/rpc/delete_me", {}, token=tok)
check("delete_me", s in (200, 204), f"{s} {r}")

s, r = call("POST", "/auth/v1/token?grant_type=refresh_token", {"refresh_token": sess["refresh_token"]})
check("deleted user can no longer refresh", s >= 400, f"{s}")
