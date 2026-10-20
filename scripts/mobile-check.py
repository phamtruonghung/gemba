#!/usr/bin/env python3
"""Phone-width measurements: horizontal overflow, tap targets under 44x44, inputs under 16px, screenshots.

    /root/.venvs/pw/bin/python scripts/mobile-check.py http://127.0.0.1:8195 shots/

Creates two guest questions on the target (one on-corpus so it gets a cited answer, one off-corpus so it
is refused), then loads each page at five phone widths and prints a table plus the offenders. Exits 1 if
any page scrolls sideways, any input is under 16px, or any non-inline tap target is under 44x44.
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8195").rstrip("/")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "shots")
OUT.mkdir(parents=True, exist_ok=True)
WIDTHS = [320, 360, 390, 414, 430]
# The operator console is behind an account; give the check one and it signs in and measures /admin/accounts too.
ADMIN_EMAIL = os.environ.get("MC_ADMIN_EMAIL")
ADMIN_PASSWORD = os.environ.get("MC_ADMIN_PASSWORD")
CHROME_MAX = 120      # px: utility bar + site header, on a phone
REPEAT_MAX = 15_000   # bytes: what a second visit to / costs
TABLE_NOTE = "/notes/vault-tpm-pillars-and-the-losses-they-target"  # the seeded note with a pipe table


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def ask(text):
    data = urllib.parse.urlencode({"q": text, "asker": "Mobile Check", "contact": "0900 000 111"}).encode()
    try:
        urllib.request.build_opener(NoRedirect).open(urllib.request.Request(BASE + "/ask", data=data))
    except urllib.error.HTTPError as e:
        loc = e.headers.get("location", "")
        if loc.startswith("/q/"):
            return loc
    raise SystemExit(f"could not create a question for {text!r}")


ANSWER = ask("What are the three parts of OEE and how do I use them?")  # on-corpus: cited answer in extractive mode
REFUSAL = ask("What is the best recipe for pho bo with a thirty-two-hour broth?")
for loc, want in ((ANSWER, "Answer from the note library"), (REFUSAL, 'class="refusal"')):
    if want not in urllib.request.urlopen(BASE + loc).read().decode():
        raise SystemExit(f"{loc} does not show {want!r}: pick a different question for this corpus")
PAGES = [("home", "/"), ("answer", ANSWER), ("refusal", REFUSAL), ("library", "/library"), ("note-table", TABLE_NOTE)]

JS = r"""
(iw) => {
  // The width we asked for, not window.innerWidth: on a mobile viewport the browser widens innerWidth to
  // fit an overflowing page, which would make every overflow read as scrollWidth == innerWidth.
  const clip = (el) => { for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') {
      const r = p.getBoundingClientRect(); if (r.right <= iw + 1 && r.left >= -1) return true; } } return false; };
  const snip = (el) => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '') + ' "' + (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) + '"';
  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || el.closest('a.skip')) continue;
    if ((r.right > iw + 1 || r.left < -1) && !clip(el) && getComputedStyle(el).position !== 'fixed') out.push(snip(el) + ' right=' + Math.round(r.right));
  }
  const taps = [];
  for (const el of document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,label[for]')) {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (el.hidden || r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || r.bottom < 0 && r.top < -200 || r.right < 0) continue;
    if (el.closest('[hidden]')) continue;
    if (el.matches('a.skip')) continue;
    if (el.tagName === 'LABEL' && el.control && el.control.getBoundingClientRect().height >= 44) continue;
    if (r.width >= 43.5 && r.height >= 43.5) continue;
    const p = el.parentElement; const inline = el.tagName === 'A' && cs.display === 'inline' && p && (p.textContent || '').trim().length > (el.textContent || '').trim().length + 3;
    taps.push({ el: snip(el), w: Math.round(r.width), h: Math.round(r.height), inline });
  }
  const small = [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,textarea')]
    .filter((e) => e.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(e).fontSize) < 16)
    .map((e) => snip(e) + ' ' + getComputedStyle(e).fontSize);
  return { sw: document.scrollingElement.scrollWidth, iw, overflow: out.slice(0, 12), taps, small };
}
"""

rows, bad, extra = [], False, []
details = {}
with sync_playwright() as p:
    br = p.chromium.launch()
    for w in WIDTHS:
        ctx = br.new_context(viewport={"width": w, "height": 800}, device_scale_factor=2, is_mobile=True, has_touch=True)
        for name, path in PAGES:
            pg = ctx.new_page()
            pg.goto(BASE + path, wait_until="load")
            pg.wait_for_timeout(150)
            r = pg.evaluate(JS, w)
            pg.screenshot(path=str(OUT / f"{name}-{w}.png"), full_page=True)
            hard = [t for t in r["taps"] if not t["inline"]]
            inline = [t for t in r["taps"] if t["inline"]]
            rows.append((name, w, f'{r["sw"]}/{w}', len(hard), len(inline), len(r["small"])))
            details[f"{name}@{w}"] = {"overflow": r["overflow"], "taps": hard[:8], "inline": inline[:6], "small": r["small"][:5]}
            bad |= r["sw"] > w or bool(r["small"]) or bool(hard)
            pg.close()
        # chrome height, and what a repeat visit to / transfers (the stylesheet is cached for a year)
        pg = ctx.new_page()
        pg.goto(BASE + "/", wait_until="load")
        chrome = pg.evaluate("() => ['.utility', 'header.site'].reduce((n, s) => { const e = document.querySelector(s); return n + (e && getComputedStyle(e).display !== 'none' ? e.getBoundingClientRect().height : 0); }, 0)")
        sizes = []
        pg.on("response", lambda r: sizes.append(int(r.headers.get("content-length", "0") or 0)))
        pg.goto(BASE + "/", wait_until="load")
        pg.wait_for_timeout(200)
        repeat = sum(sizes)
        extra.append((w, round(chrome), repeat))
        bad |= chrome > CHROME_MAX or repeat > REPEAT_MAX
        pg.close()
        if ADMIN_EMAIL and ADMIN_PASSWORD:
            pg = ctx.new_page()
            pg.goto(BASE + "/admin/login", wait_until="load")
            pg.fill("#email", ADMIN_EMAIL)
            pg.fill("#password", ADMIN_PASSWORD)
            pg.click("button[type=submit]")
            pg.wait_for_load_state("load")
            pg.goto(BASE + "/admin/accounts", wait_until="load")
            r = pg.evaluate(JS, w)
            hard = [t for t in r["taps"] if not t["inline"]]
            rows.append(("admin-acct", w, f'{r["sw"]}/{w}', len(hard), len(r["taps"]) - len(hard), len(r["small"])))
            details[f"admin-acct@{w}"] = {"overflow": r["overflow"], "taps": hard[:8], "inline": [], "small": r["small"][:5]}
            bad |= r["sw"] > w or bool(r["small"]) or bool(hard)
            pg.close()
        ctx.close()
    br.close()

print(f"{'page':<11}{'width':>6}{'scrollW/innerW':>16}{'taps<44':>9}{'inline<44':>11}{'inputs<16':>11}")
for row in rows:
    print(f"{row[0]:<11}{row[1]:>6}{row[2]:>16}{row[3]:>9}{row[4]:>11}{row[5]:>11}")
if "-v" in sys.argv or "--verbose" in sys.argv or True:
    for k, v in details.items():
        if v["overflow"] or v["taps"] or v["small"] or v["inline"]:
            print(f"\n{k}\n  " + json.dumps(v, ensure_ascii=False, indent=1).replace("\n", "\n  "))
print(f"\n{'width':>6}{'utility+header px':>19}{'repeat visit /':>16}")
for w, chrome, repeat in extra:
    print(f"{w:>6}{chrome:>19}{repeat:>13} B")
print("\nANSWER:", ANSWER, " REFUSAL:", REFUSAL)
sys.exit(1 if bad else 0)
