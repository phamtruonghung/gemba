#!/usr/bin/env python3
"""Ask the browser what it actually painted for one block, and how the parts relate.

The screenshot tells you the composite colour of a region; it cannot tell you which element is
responsible or whether a translucent layer is sitting on top of something else. This prints the
computed styles, the ancestor chain with each background, and the effective contrast of the text —
the three things needed to tell "I styled it wrong" apart from "a layer covers it".
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile

from playwright.async_api import async_playwright

CHROME = "/snap/chromium/current/usr/lib/chromium-browser/chrome"
PORT = os.environ.get("PROBE_PORT", "8123")
TMP = tempfile.mkdtemp(prefix="probe-")

JS = """(needle) => {
  const hit = [...document.querySelectorAll('section, div, footer, header')]
    .filter((el) => (el.textContent || '').includes(needle) && el.children.length < 30)
    .pop();
  if (!hit) return { error: 'not found: ' + needle };
  const chain = [];
  let n = hit;
  while (n && n !== document.documentElement.parentElement) {
    const cs = getComputedStyle(n);
    chain.push({
      tag: n.tagName.toLowerCase(),
      cls: n.className && n.className.toString().slice(0, 60),
      bg: cs.backgroundColor,
      color: cs.color,
    });
    n = n.parentElement;
  }
  const p = hit.querySelector('p, .lead, .eyebrow, h2, h3');
  const pcs = p ? getComputedStyle(p) : null;
  return {
    found: { tag: hit.tagName.toLowerCase(), cls: (hit.className || '').toString().slice(0, 60),
             bg: getComputedStyle(hit).backgroundColor, rect: hit.getBoundingClientRect().toJSON() },
    sample: p ? { text: (p.textContent || '').trim().slice(0, 50), color: pcs.color,
                  size: pcs.fontSize, weight: pcs.fontWeight } : null,
    chain: chain.slice(0, 8)
  };
}"""


async def main():
    url = sys.argv[1]
    needles = sys.argv[2:]
    env = dict(os.environ)
    env.pop("XUONG_USER", None)
    subprocess.Popen(
        ["node", "src/server.mjs"],
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        env={**env, "XUONG_PORT": PORT, "XUONG_DB": f"{TMP}/probe.db"},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
    )
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        for scheme in ("light", "dark"):
            ctx = await browser.new_context(viewport={"width": 1280, "height": 900}, color_scheme=scheme)
            page = await ctx.new_page()
            for _ in range(40):
                try:
                    await page.goto(url, wait_until="load", timeout=4000)
                    break
                except Exception:
                    await asyncio.sleep(0.5)
            for needle in needles:
                print(f"--- {scheme}: {needle}")
                print(json.dumps(await page.evaluate(JS, needle), indent=2, ensure_ascii=False))
            await ctx.close()
        await browser.close()


asyncio.run(main())
