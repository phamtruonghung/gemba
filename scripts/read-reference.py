#!/usr/bin/env python3
"""Read the structure and the visual system off a reference page, so a redesign copies the shape
rather than the vibe. Prints an outline plus the computed styles that matter, and writes screenshots.
"""
import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "https://arbolus.com/"
SHOTS = Path("/root/.hermes/cache/scratch/ref-shots")
SHOTS.mkdir(parents=True, exist_ok=True)

OUTLINE_JS = """
() => {
  const out = [];
  for (const el of document.querySelectorAll('header, nav, main > *, main section, section, footer')) {
    if (!el.getClientRects().length) continue;
    const heads = [...el.querySelectorAll('h1,h2,h3')].map((h) => h.tagName + ':' + h.innerText.trim().slice(0, 70));
    const paras = [...el.querySelectorAll('p')].map((p) => p.innerText.trim().slice(0, 80)).filter(Boolean).slice(0, 3);
    const links = [...el.querySelectorAll('a')].map((a) => a.innerText.trim().slice(0, 30)).filter(Boolean).slice(0, 8);
    out.push({
      tag: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 2).join('.') : ''),
      y: Math.round(el.getBoundingClientRect().top + window.scrollY),
      h: Math.round(el.getBoundingClientRect().height),
      heads, paras, links,
    });
  }
  return out.sort((a, b) => a.y - b.y);
}
"""

STYLE_JS = """
() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { sel, text: (el.innerText || '').trim().slice(0, 40), bg: cs.backgroundColor, color: cs.color,
             border: cs.borderColor, radius: cs.borderRadius, pad: cs.padding, font: cs.fontFamily,
             size: cs.fontSize, weight: cs.fontWeight, ls: cs.letterSpacing, lh: cs.lineHeight, transform: cs.textTransform };
  };
  const cssVars = {};
  const rootStyle = getComputedStyle(document.documentElement);
  for (const name of rootStyle) if (name.startsWith('--')) cssVars[name] = rootStyle.getPropertyValue(name).trim().slice(0, 40);
  return {
    body: pick('body'), h1: pick('h1'), h2: pick('h2'), p: pick('main p'),
    navLink: pick('header a, nav a'), button: pick('a[class*=btn], button, a[class*=button]'),
    card: pick('[class*=card], [class*=Card]'),
    vars: Object.fromEntries(Object.entries(cssVars).slice(0, 40)),
  };
}
"""


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
        page = ctx.new_page()
        page.goto(URL, wait_until="load", timeout=60000)
        page.wait_for_timeout(3500)
        # scroll through so lazy sections render, then back to the top
        page.evaluate("async () => { for (let y = 0; y < document.body.scrollHeight; y += 800) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); } window.scrollTo(0, 0); }")
        page.wait_for_timeout(1500)
        print("== outline ==")
        print(json.dumps(page.evaluate(OUTLINE_JS), indent=1)[:6000])
        print("== styles ==")
        print(json.dumps(page.evaluate(STYLE_JS), indent=1)[:4000])
        print("== headings ==")
        print(json.dumps(page.evaluate("() => [...document.querySelectorAll('h1,h2,h3')].map(h => h.tagName + ' | ' + h.innerText.trim().slice(0,90))"), indent=1))
        print("== nav + footer links ==")
        print(json.dumps(page.evaluate("() => ({ nav: [...document.querySelectorAll('header a, nav a')].map(a => a.innerText.trim()).filter(Boolean), footer: [...document.querySelectorAll('footer a')].map(a => a.innerText.trim()).filter(Boolean) })"), indent=1))
        page.screenshot(path=str(SHOTS / "ref-full-1440.png"), full_page=True)
        page.screenshot(path=str(SHOTS / "ref-hero-1440.png"))
        ctx375 = browser.new_context(viewport={"width": 375, "height": 900}, device_scale_factor=1, is_mobile=True, has_touch=True)
        p375 = ctx375.new_page()
        p375.goto(URL, wait_until="load", timeout=60000)
        p375.wait_for_timeout(3000)
        p375.screenshot(path=str(SHOTS / "ref-hero-375.png"))
        browser.close()
    print("\nshots:", sorted(p.name for p in SHOTS.glob("*.png")))


if __name__ == "__main__":
    main()
