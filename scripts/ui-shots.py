#!/usr/bin/env python3
"""Screenshots of the signed-in surfaces: account, question with a cited answer, the refusal."""
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

# The repo this file lives in — never a path from the machine it was written on.
ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("UI_PORT", "8098"))
BASE = f"http://127.0.0.1:{PORT}"
SHOTS = Path(os.environ.get("SHOT_DIR") or Path(tempfile.gettempdir()) / "gemba-ui-shots")
SHOTS.mkdir(parents=True, exist_ok=True)

# A screenshot taken while an entrance animation is running captures the band at partial opacity:
# the picture then shows a mid-grey band carrying pale text that does not exist a moment later, and a
# reviewer (or a vision model) reports a contrast failure that is not real. Reduced motion plus an
# explicit kill switch pins every capture to the settled page a reader actually sees.
SETTLE_CSS = "*{animation:none!important;transition:none!important;opacity:1!important}"


def shot(page, name, full=True):
    page.emulate_media(reduced_motion="reduce")
    page.add_style_tag(content=SETTLE_CSS)
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=full)



def main():
    # A seeded file database, not ':memory:' — an empty corpus has no notes to open and no experts
    # to book, which is exactly the state a screenshot tool must not be fooled by.
    db_path = str(Path(tempfile.gettempdir()) / "gemba-ui-shots.db")
    for suffix in ("", "-wal", "-shm"):
        Path(db_path + suffix).unlink(missing_ok=True)
    subprocess.run(["node", "scripts/seed.mjs"], cwd=ROOT, env={**os.environ, "GEMBA_DB": db_path}, stdout=subprocess.DEVNULL, check=True)
    proc = subprocess.Popen(
        ["node", "src/server.mjs"], cwd=ROOT,
        env={**os.environ, "GEMBA_PORT": str(PORT), "GEMBA_DB": db_path},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(40):
            r = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", f"{BASE}/healthz"], capture_output=True, text=True)
            if r.stdout.strip() == "200":
                break
            time.sleep(0.25)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
            for scheme in ("light", "dark"):
                ctx = browser.new_context(viewport={"width": 1280, "height": 900}, color_scheme=scheme)
                page = ctx.new_page()
                # sign up through the real form
                page.goto(BASE + "/signup", wait_until="load")
                page.fill("#name", "Hung")
                page.fill("#email", "hung@example.com")
                page.fill("#password", "a sentence of ten characters")
                page.click("button[type=submit]")
                page.wait_for_load_state("load")
                shot(page, f"account-{scheme}")

                # a question the library covers, then one it does not
                page.goto(BASE + "/", wait_until="load")
                page.fill("#q", "the machine stops mid-shift, what do I check and in what order")
                page.click("button[type=submit]")
                page.wait_for_load_state("load")
                shot(page, f"question-cited-{scheme}")

                page.goto(BASE + "/", wait_until="load")
                page.fill("#q", "what is a good CRM for my sales team?")
                page.click("button[type=submit]")
                page.wait_for_load_state("load")
                shot(page, f"question-refused-{scheme}")

                # the note page itself, reached the way a reader reaches it: the card's own title
                page.goto(BASE + "/library", wait_until="load")
                page.click(".grid article h3 a")
                page.wait_for_load_state("load")
                shot(page, f"note-{scheme}")

                # the whole landing page, which is the thing a redesign has to be judged on
                page.goto(BASE + "/", wait_until="load")
                shot(page, f"home-{scheme}")
                shot(page, f"hero-{scheme}", full=False)

                # and the same page at phone width, where a landing page usually breaks
                phone = ctx.browser.new_context(viewport={"width": 375, "height": 900}, color_scheme=scheme, is_mobile=True, has_touch=True)
                p375 = phone.new_page()
                p375.goto(BASE + "/", wait_until="load")
                shot(p375, f"home-375-{scheme}")
                phone.close()
                ctx.close()
            browser.close()
        print("screenshots:", sorted(p.name for p in SHOTS.glob("*.png")))
    finally:
        proc.terminate()
        proc.wait(timeout=10)


if __name__ == "__main__":
    sys.exit(main())
