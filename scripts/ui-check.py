#!/usr/bin/env python3
"""UI checks for the redesigned pages: responsive, contrast, focus, tap targets, labels.

Runs headless Chromium against a locally started instance. Prints one line per check and exits
non-zero if any check fails, so it can gate a deploy the same way the test suite does.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

# The repo this file lives in — never a path from the machine it was written on.
ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("UI_PORT", "8097"))
# UI_BASE points the same checks at a running deployment (the LXC, the public tunnel) instead of
# booting a local one; UI_USER/UI_PASS fill the front gate's basic-auth dialog when it is on.
BASE = os.environ.get("UI_BASE") or f"http://127.0.0.1:{PORT}"
EXTERNAL = bool(os.environ.get("UI_BASE"))
# Default to the system temp dir: a hard-coded path from the author's machine is a check that
# passes here and cannot pass anywhere else (CI caught exactly that).
SHOTS = Path(os.environ.get("SHOT_DIR") or Path(tempfile.gettempdir()) / "gemba-ui-shots")
SHOTS.mkdir(parents=True, exist_ok=True)

PAGES = [
    ("home", "/"),
    ("signup", "/signup"),
    ("signin", "/signin"),
    ("library", "/library"),
    ("experts", "/experts"),
    ("how-it-works", "/how-it-works"),
]

# The operator surface is behind an account, so it cannot be reached by walking the public pages. The
# checks below sign in like a person does. On the local instance this script creates its own operator;
# against a deployment (UI_BASE) it needs UI_ADMIN_EMAIL/UI_ADMIN_PASSWORD, and says so out loud rather
# than reporting a pass it did not earn.
ADMIN_EMAIL = os.environ.get("UI_ADMIN_EMAIL") or (None if EXTERNAL else "operator@gemba.local")
ADMIN_PASSWORD = os.environ.get("UI_ADMIN_PASSWORD") or (None if EXTERNAL else "ui-check-operator-password")
ADMIN_PAGES = [
    ("operator-overview", "/admin"),
    ("operator-practitioners", "/admin/experts"),
    ("operator-bookings", "/admin/bookings"),
    ("operator-accounts", "/admin/accounts"),
    ("operator-invitations", "/admin/invites"),
    ("operator-settings", "/admin/settings"),
    ("operator-audit", "/admin/audit"),
]

failures = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(name)


# WCAG relative luminance / contrast
def luminance(rgb):
    def chan(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2])


def contrast(fg, bg):
    l1, l2 = luminance(fg), luminance(bg)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


def parse_rgb(s):
    m = re.findall(r"[\d.]+", s or "")
    return tuple(int(float(x)) for x in m[:3]) if len(m) >= 3 else None


CONTRAST_JS = """
() => {
  const out = [];
  const els = document.querySelectorAll('p, li, a, button, .btn, h1, h2, h3, .muted, .badge, .lead, label, td, th, .hint, .field-error');
  const opaque = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      const m = /rgba?\\(([^)]+)\\)/.exec(bg);
      if (m) {
        const parts = m[1].split(',').map((x) => parseFloat(x));
        if (parts.length < 4 || parts[3] > 0.95) return bg;
      }
      n = n.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  };
  for (const el of els) {
    const text = (el.textContent || '').trim();
    if (!text) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (!el.getClientRects().length) continue;
    out.push({ text: text.slice(0, 40), color: cs.color, bg: opaque(el), size: parseFloat(cs.fontSize), weight: cs.fontWeight });
  }
  return out;
}
"""


def sample_png(path):
    """Return (dominant colour, its share) for a PNG the browser just wrote."""
    from PIL import Image
    img = Image.open(path).convert("RGB")
    counts = {}
    for pixel in img.getdata():
        counts[pixel] = counts.get(pixel, 0) + 1
    if not counts:
        return None, 0.0
    colour, n = max(counts.items(), key=lambda kv: kv[1])
    return colour, n / (img.width * img.height)


def main():
    if EXTERNAL:
        print(f"checking the running instance at {BASE} instead of starting one")
        run_checks()
        print(f"\n{'ALL CHECKS PASSED' if not failures else 'FAILURES: ' + ', '.join(failures)}")
        return 1 if failures else 0
    # Seeded, not ':memory:'. An empty corpus renders a different page — no notes, no experts,
    # zeros in the stats — and checking that page is checking a page nobody will ever see.
    db_path = str(Path(tempfile.gettempdir()) / "gemba-ui-check.db")
    for suffix in ("", "-wal", "-shm"):
        Path(db_path + suffix).unlink(missing_ok=True)
    subprocess.run(["node", "scripts/seed.mjs"], cwd=ROOT, env={**os.environ, "GEMBA_DB": db_path}, stdout=subprocess.DEVNULL, check=True)
    if ADMIN_EMAIL and ADMIN_PASSWORD:
        subprocess.run(
            ["node", "scripts/admin-create.mjs"],
            cwd=ROOT,
            env={**os.environ, "GEMBA_DB": db_path, "GEMBA_ADMIN_EMAIL": ADMIN_EMAIL, "GEMBA_ADMIN_PASSWORD": ADMIN_PASSWORD},
            stdout=subprocess.DEVNULL,
            check=True,
        )
    proc = subprocess.Popen(
        ["node", "src/server.mjs"],
        cwd=ROOT,
        env={**os.environ, "GEMBA_PORT": str(PORT), "GEMBA_DB": db_path, "GEMBA_LLM_KEY": ""},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(40):
            try:
                r = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", f"{BASE}/healthz"], capture_output=True, text=True)
                if r.stdout.strip() == "200":
                    break
            except Exception:
                pass
            time.sleep(0.25)
        else:
            print("instance did not start")
            return 1
        run_checks()
    finally:
        proc.terminate()
        proc.wait(timeout=10)
    print(f"\n{'ALL CHECKS PASSED' if not failures else 'FAILURES: ' + ', '.join(failures)}")
    return 1 if failures else 0


# A capture taken while the entry fade is still running photographs a dark band at partial opacity:
# mid-grey with pale text. That is a picture of an animation, not of the design, and it is how a
# contrast alarm (or a false all-clear) gets raised by the screenshots this script leaves behind.
SETTLE_CSS = "*{animation:none!important;transition:none!important;opacity:1!important}"


def settle(page):
    page.emulate_media(reduced_motion="reduce")
    page.add_style_tag(content=SETTLE_CSS)


def admin_pass(browser):
    """Sign in and walk the operator pages the way the operator does."""
    if not (ADMIN_EMAIL and ADMIN_PASSWORD):
        check("operator pages — credentials to check them with", False,
              "UI_ADMIN_EMAIL/UI_ADMIN_PASSWORD are unset, so the operator surface was NOT checked")
        return
    ctx = browser.new_context(
        viewport={"width": 1440, "height": 900},
        http_credentials=(
            {"username": os.environ["UI_USER"], "password": os.environ["UI_PASS"]}
            if os.environ.get("UI_USER") and os.environ.get("UI_PASS")
            else None
        ),
    )
    page = ctx.new_page()

    # an anonymous visitor meets the door, not the room
    page.goto(BASE + "/admin", wait_until="load")
    check("operator — a visitor is sent to sign in", "/admin/login" in page.url and "next" in page.url, page.url)

    settle(page)
    page.fill("#email", ADMIN_EMAIL)
    page.fill("#password", "not-the-password")
    page.click("button[type=submit]")
    page.wait_for_load_state("load")
    check("operator — a wrong password is refused", page.url.endswith("/admin/login") and "do not match" in page.content(),
          page.url)

    page.fill("#email", ADMIN_EMAIL)
    page.fill("#password", ADMIN_PASSWORD)
    page.click("button[type=submit]")
    page.wait_for_load_state("load")
    check("operator — the right password lands on the overview", page.url.endswith("/admin") and "What the instance is doing" in page.content(),
          page.url)

    for name, path in ADMIN_PAGES:
        resp = page.goto(BASE + path, wait_until="load")
        settle(page)
        status = resp.status if resp else 0
        check(f"{name} — loads", status == 200, f"HTTP {status}")

        overflow = page.evaluate(
            "() => document.documentElement.scrollWidth - document.documentElement.clientWidth"
        )
        check(f"{name} — no horizontal overflow", overflow <= 1, f"{overflow}px wider than the viewport")

        rows = page.evaluate(CONTRAST_JS)
        worst = None
        for row in rows:
            fg, bg = parse_rgb(row["color"]), parse_rgb(row["bg"])
            if not fg or not bg:
                continue
            ratio = contrast(fg, bg)
            large = row["size"] >= 24 or (row["size"] >= 18.66 and int(row["weight"]) >= 700)
            need = 3.0 if large else 4.5
            if ratio < need and (worst is None or ratio < worst[1]):
                worst = (row["text"], ratio, need)
        check(f"{name} — contrast ≥4.5:1", worst is None,
              f"{worst[0][:28]!r} at {worst[1]:.2f} (needs {worst[2]})" if worst else "")

        unlabelled = page.evaluate(
            """() => {
              const out = [];
              for (const el of document.querySelectorAll('input:not([type=hidden]), textarea, select')) {
                const id = el.id;
                const lab = id ? document.querySelector('label[for="' + id + '"]') : null;
                if (!lab) out.push(el.name || el.id || el.tagName);
              }
              return out;
            }"""
        )
        check(f"{name} — every field has a label", not unlabelled, ", ".join(unlabelled))

        current = page.evaluate("() => { const a = document.querySelector('.admin-nav a[aria-current]'); return a ? a.getAttribute('href') : null; }")
        check(f"{name} — the console marks the current page", current == path, str(current))

    # narrow: the operator console has to work on the phone an operator actually carries
    narrow = browser.new_context(viewport={"width": 375, "height": 900},
                                 http_credentials=(
                                     {"username": os.environ["UI_USER"], "password": os.environ["UI_PASS"]}
                                     if os.environ.get("UI_USER") and os.environ.get("UI_PASS") else None))
    npage = narrow.new_page()
    npage.goto(BASE + "/admin/login", wait_until="load")
    settle(npage)
    npage.fill("#email", ADMIN_EMAIL)
    npage.fill("#password", ADMIN_PASSWORD)
    npage.click("button[type=submit]")
    npage.wait_for_load_state("load")
    for name, path in [("operator-overview", "/admin"), ("operator-practitioners", "/admin/experts"),
                       ("operator-bookings", "/admin/bookings"), ("operator-accounts", "/admin/accounts")]:
        npage.goto(BASE + path, wait_until="load")
        settle(npage)
        over = npage.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check(f"{name} — no horizontal overflow at 375px", over <= 1, f"{over}px wider")
    narrow.close()
    ctx.close()


def phone_cta(browser):
    """At 360x640 a tap on the hero's Ask button has to put the question box on screen.

    Not scrollY: Playwright scrolls a button into view before it clicks it, so scrollY is non-zero even
    when the anchor is dead. The box being inside the viewport afterwards is what a person sees.
    """
    ctx = browser.new_context(
        viewport={"width": 360, "height": 640},
        http_credentials=(
            {"username": os.environ["UI_USER"], "password": os.environ["UI_PASS"]}
            if os.environ.get("UI_USER") and os.environ.get("UI_PASS")
            else None
        ),
    )
    page = ctx.new_page()
    page.goto(BASE + "/", wait_until="load")
    for label, selector in (("the hero button", "main a.btn[href='#ask']"), ("the nav link", "nav.site a[href='/#ask']")):
        page.goto(BASE + "/", wait_until="load")
        target = page.locator(selector).first
        if not target.count():
            check(f"tapping {label} puts the question box on screen @360x640", False, f"no {selector}")
            continue
        top_before = page.evaluate("() => document.querySelector('#q').getBoundingClientRect().top")
        target.click()
        page.wait_for_timeout(300)
        top = page.evaluate("() => document.querySelector('#q').getBoundingClientRect().top")
        inside = 0 <= top < page.evaluate("() => innerHeight")
        check(f"tapping {label} puts the question box on screen @360x640", inside, f"#q top {top_before:.0f}px -> {top:.0f}px")
    ctx.close()


def run_checks():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=os.environ.get("CHROME_PATH") or None,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        for scheme in ("light", "dark"):
            for width in (375, 1440):
                ctx = browser.new_context(
                    viewport={"width": width, "height": 900},
                    color_scheme=scheme,
                    device_scale_factor=1,
                    http_credentials=(
                        {"username": os.environ["UI_USER"], "password": os.environ["UI_PASS"]}
                        if os.environ.get("UI_USER") and os.environ.get("UI_PASS")
                        else None
                    ),
                )
                page = ctx.new_page()
                for name, path in PAGES:
                    page.goto(BASE + path, wait_until="load")
                    tag = f"{name} @{width} {scheme}"

                    overflow = page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
                    check(f"no horizontal scroll — {tag}", overflow <= 1, f"overflow {overflow}px")

                    small = page.evaluate(
                        """() => {
                          const bad = [];
                          for (const el of document.querySelectorAll('a, button, input:not([type=checkbox]), select, textarea')) {
                            const r = el.getBoundingClientRect();
                            if (!r.width || !r.height) continue;
                            if (getComputedStyle(el).visibility === 'hidden') continue;
                            // A link inside a sentence — or a heading that is itself a link — is text,
                            // not a control: WCAG 2.2 (2.5.8) exempts inline targets. Chips, nav items,
                            // buttons, selects and fields are controls and stay held to 44px.
                            if (el.tagName === 'A' && el.closest('p, li, dd, dt, .answer, h1, h2, h3, h4')) continue;
                            if (r.height < 44) bad.push((el.tagName + ':' + (el.textContent || el.name || '').trim().slice(0, 24)) + ' h=' + Math.round(r.height));
                          }
                          return bad;
                        }"""
                    )
                    check(f"tap targets ≥44px — {tag}", not small, "; ".join(small[:3]))

                    # An in-page link must land on something. Two "Ask" buttons pointed at #ask for a long
                    # time while nothing carried that id: the tap set the hash and the page did not move.
                    # `/#x` links only count on the home page, where the target lives.
                    dead = page.evaluate(
                        """(isHome) => {
                          const bad = [];
                          for (const a of document.querySelectorAll('a[href^="#"], a[href^="/#"]')) {
                            const href = a.getAttribute('href');
                            const id = href.replace(/^\\/?#/, '');
                            if (href.startsWith('/#') && !isHome) continue;
                            if (id && !document.getElementById(id)) bad.push(href);
                          }
                          return bad;
                        }""",
                        path == "/",
                    )
                    check(f"every in-page link resolves — {tag}", not dead, "; ".join(dead[:3]))

                    contrast_rows = page.evaluate(CONTRAST_JS)
                    worst = None
                    for row in contrast_rows:
                        fg, bg = parse_rgb(row["color"]), parse_rgb(row["bg"])
                        if not fg or not bg:
                            continue
                        ratio = contrast(fg, bg)
                        large = row["size"] >= 24 or (row["size"] >= 18.66 and int(row["weight"]) >= 700)
                        need = 3.0 if large else 4.5
                        if ratio < need and (worst is None or ratio < worst[1]):
                            worst = (row["text"], ratio, need)
                    check(f"contrast ≥4.5:1 — {tag}", worst is None, f"{worst[0][:28]!r} at {worst[1]:.2f} (needs {worst[2]})" if worst else "")

                    # Cards standing side by side must line up. This is the check that was missing when
                    # every card in the band had its action row at a different height: the cause was an
                    # inline `margin:0` overriding the `margin-top:auto` meant to push the action down,
                    # and no style-based check noticed because each card was individually valid.
                    misaligned = page.evaluate(
                        """() => {
                          const out = [];
                          for (const grid of document.querySelectorAll('.grid')) {
                            const rows = new Map();
                            for (const card of grid.querySelectorAll(':scope > article.card')) {
                              const last = card.lastElementChild;
                              if (!last) continue;
                              const cr = card.getBoundingClientRect();
                              const rt = Math.round(cr.top);
                              const off = Math.round(cr.bottom - last.getBoundingClientRect().bottom);
                              if (!rows.has(rt)) rows.set(rt, []);
                              rows.get(rt).push(off);
                            }
                            for (const [rt, offs] of rows) {
                              if (offs.length > 1 && Math.max(...offs) - Math.min(...offs) > 2) {
                                out.push('row@' + rt + ' -> ' + offs.join('/'));
                              }
                            }
                          }
                          return out;
                        }"""
                    )
                    check(f"card actions line up — {tag}", not misaligned, "; ".join(misaligned[:3]))

                    if width == 1440:
                        settle(page)
                        page.screenshot(path=str(SHOTS / f"{name}-{scheme}.png"), full_page=True)

                # keyboard: the first Tab reaches the skip link, and focus is visible
                page.goto(BASE + "/", wait_until="load")
                page.keyboard.press("Tab")
                first = page.evaluate("() => ({ tag: document.activeElement.tagName, text: document.activeElement.textContent.trim().slice(0,20), cls: document.activeElement.className })")
                check(f"first Tab reaches the skip link — {scheme}", first["cls"] == "skip", json.dumps(first))
                outline = page.evaluate("() => { const cs = getComputedStyle(document.activeElement); return { w: cs.outlineWidth, style: cs.outlineStyle, color: cs.outlineColor }; }")
                check(f"focus is visible — {scheme}", outline["style"] != "none" and float(outline["w"].replace("px", "")) >= 2, json.dumps(outline))

                # aria-current marks the nav item for the page you are on
                page.goto(BASE + "/library", wait_until="load")
                cur = page.evaluate("() => { const a = document.querySelector('nav.site a[aria-current]'); return a ? a.getAttribute('href') : null; }")
                check(f"nav marks the current page — {scheme}", cur == "/library", str(cur))

                # labels and helpers are wired to their inputs
                page.goto(BASE + "/signup", wait_until="load")
                labelled = page.evaluate(
                    """() => {
                      const out = [];
                      for (const el of document.querySelectorAll('input:not([type=hidden]), textarea, select')) {
                        const id = el.id;
                        const lab = id ? document.querySelector('label[for="' + id + '"]') : null;
                        if (!lab) out.push(el.name || el.id || el.tagName);
                      }
                      return out;
                    }"""
                )
                check(f"every field has a label — {scheme}", not labelled, ", ".join(labelled))

                no_emoji = page.evaluate(
                    """() => {
                      const text = document.body.innerText;
                      const emoji = /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}]/u;
                      return emoji.test(text) ? text.match(emoji)[0] : null;
                    }"""
                )
                check(f"no emoji used as UI — {scheme}", no_emoji is None, str(no_emoji))

                # The primary action, measured in the rendered pixels. A CTA that merely *computes*
                # to a strong colour can still paint pale, so this samples the PNG the browser drew
                # for the element itself: the majority colour inside the button.
                page.goto(BASE + "/", wait_until="load")
                submit = page.locator("button[type=submit]").first
                submit.scroll_into_view_if_needed()
                shot = SHOTS / f"_cta-{width}-{scheme}.png"
                submit.screenshot(path=str(shot))
                dominant, share = sample_png(shot)
                # "Solid" means the button paints its own fill, not the surface behind it — in dark
                # mode the accent is light with dark text, so comparing it to white would be wrong.
                surface = parse_rgb(page.evaluate("() => getComputedStyle(document.querySelector('.card')).backgroundColor"))
                distinct = dominant is not None and contrast(dominant, surface) >= 1.6
                check(
                    f"the primary CTA paints its own solid fill — {tag}",
                    share >= 0.5 and distinct,
                    f"dominant pixel {dominant} on {share * 100:.0f}% of the button, card surface {surface}"
                )
                centre = page.evaluate(
                    """() => {
                      const r = document.querySelector('button[type=submit]').getBoundingClientRect();
                      const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
                      const cs = getComputedStyle(el);
                      return { tag: el.tagName, bg: cs.backgroundColor, fg: cs.color };
                    }"""
                )
                btn_ratio = contrast(parse_rgb(centre["fg"]), parse_rgb(centre["bg"]))
                check(
                    f"CTA label contrast ≥4.5:1 — {tag}",
                    centre["tag"] == "BUTTON" and btn_ratio >= 4.5,
                    f"{btn_ratio:.2f}:1 on {centre['bg']}, element under the centre: {centre['tag']}"
                )

                # dark mode really changed something
                if scheme == "dark":
                    bg = page.evaluate("() => getComputedStyle(document.body).backgroundColor")
                    check("dark mode is applied", parse_rgb(bg) is not None and sum(parse_rgb(bg)) < 200, bg)

                # The reading view: a note is markdown and a reader should see prose. A screenshot cannot
                # assert this, and a test on the renderer alone misses the wiring between page and server.
                page.goto(BASE + "/library", wait_until="load")
                first_note = page.evaluate("() => { const a = document.querySelector('a[href^=\"/notes/\"]'); return a ? a.getAttribute('href') : null; }")
                if not first_note:
                    check(f"a note is reachable from the library — {scheme}", False, "no note link on /library")
                else:
                    page.goto(BASE + first_note, wait_until="load")
                    prose = page.evaluate(
                        """() => {
                          const el = document.querySelector('.prose');
                          return el ? { blocks: el.children.length, text: el.innerText } : { blocks: 0, text: '' };
                        }"""
                    )
                    check(f"the note body renders as prose — {scheme}", prose["blocks"] > 0, f"{prose['blocks']} blocks")
                    leak = re.search(r"\[\[|\*\*|(^|\s)#{2,}\s", prose["text"], re.M)
                    check(f"no markdown syntax survives on a note page — {scheme}", leak is None, repr(leak.group(0)) if leak else "")

                # A form that waits on a model has to say so, or a working form reads as a broken one.
                page.goto(BASE + "/", wait_until="load")
                pending = page.evaluate(
                    """() => {
                      const form = document.querySelector('form[data-pending]');
                      const script = [...document.scripts].some((s) => s.textContent.includes('data-pending'));
                      if (!form) return { ok: false, why: 'no form declares data-pending' };
                      return { ok: script && !!form.querySelector('[data-pending-note]'), why: script ? '' : 'no script handles it' };
                    }"""
                )
                check(f"the ask form announces that it is working — {scheme}", pending["ok"], pending["why"])

                ctx.close()
        phone_cta(browser)
        admin_pass(browser)
        browser.close()


if __name__ == "__main__":
    sys.exit(main())
