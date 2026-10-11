import asyncio, os, subprocess, sys, time
from playwright.async_api import async_playwright

ROOT = __import__("pathlib").Path(__file__).resolve().parent.parent
DB = "/tmp/prose-shot.db"
for suffix in ("", "-wal", "-shm"):
    try: os.remove(DB + suffix)
    except FileNotFoundError: pass

env = {**os.environ, "GEMBA_DB": DB, "GEMBA_PORT": "8098", "GEMBA_HOST": "127.0.0.1"}
subprocess.run(["node", "scripts/seed.mjs"], cwd=ROOT, env=env, check=True, stdout=subprocess.DEVNULL)
server = subprocess.Popen(["node", "src/server.mjs"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
OUT = "/root/.hermes/cache/scratch/gemba-prose"
os.makedirs(OUT, exist_ok=True)

async def main():
    for _ in range(40):
        try:
            async with async_playwright() as p:
                break
        except Exception:
            time.sleep(0.5)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path="/snap/chromium/current/usr/lib/chromium-browser/chrome", args=["--no-sandbox"])
        # the table note and a bulleted note, because those are the two shapes that read worst as raw markdown
        for slug, name in [("vault-tpm-pillars-and-the-losses-they-target", "note-table"), ("demo-5-why-and-how-to-ask-until-you-reach-something-you-can-fix", "note-prose")]:
            for width, wname in ((1440, "1440"), (375, "375")):
                page = await browser.new_page(viewport={"width": width, "height": 1000})
                await page.emulate_media(color_scheme="light")
                await page.goto(f"http://127.0.0.1:8098/notes/{slug}", wait_until="load")
                await page.wait_for_timeout(900)
                await page.screenshot(path=f"{OUT}/{name}-{wname}.png", full_page=False)
                await page.close()
        await browser.close()

    # report what the browser actually painted for two blocks, measured rather than eyeballed
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path="/snap/chromium/current/usr/lib/chromium-browser/chrome", args=["--no-sandbox"])
        page = await browser.new_page(viewport={"width": 1440, "height": 1000})
        await page.goto("http://127.0.0.1:8098/notes/vault-tpm-pillars-and-the-losses-they-target", wait_until="load")
        await page.wait_for_timeout(700)
        print("prose blocks painted:", await page.evaluate("document.querySelectorAll('.prose > *').length"))
        print("first heading:", await page.evaluate("(document.querySelector('.prose h2,.prose h3')||{}).textContent"))
        print("table rows:", await page.evaluate("document.querySelectorAll('.prose table tbody tr').length"))
        print("raw hashes on the page:", await page.evaluate("/(^|\\\\s)#{1,6}\\\\s/.test(document.querySelector('.prose').innerText)"))
        await browser.close()

asyncio.run(main())
server.terminate()
print("shots in", OUT)
