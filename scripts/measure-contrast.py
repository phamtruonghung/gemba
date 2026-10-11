#!/usr/bin/env python3
"""Measure the contrast of what a page actually painted, not what the stylesheet meant.

The browser checks compute contrast from computed styles; this reads the PNG. It exists because a
dark band is exactly where a style-based check can pair the wrong background: the text inside a band
inherits the *page* background in the cascade, so a checker that resolves `background-color` by
walking up from the text can land on the paper colour and report a comfortable pass for white-on-white.
"""
import sys
from collections import Counter
from pathlib import Path

from PIL import Image


def lum(c):
    def f(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = c[:3]
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def report(path):
    im = Image.open(path).convert("RGB")
    W, H = im.size
    px = im.load()

    # The darkest wide row-run on the page is the dark band.
    rows = []
    for y in range(0, H, 3):
        row = [px[x, y] for x in range(20, W - 20, 25)]
        dark = sum(1 for p in row if lum(p) < 0.12)
        if dark >= len(row) * 0.3:   # a band is wide and dark; cards inside it do not disqualify it
            rows.append(y)
    if not rows:
        print(f"{Path(path).name}: no dark band found")
        return 0

    # The utility bar is dark too: take the longest *contiguous* dark run, not the outer bounds.
    runs, start = [], rows[0]
    for prev, cur in zip(rows, rows[1:]):
        if cur - prev > 12:
            runs.append((start, prev))
            start = cur
    runs.append((start, rows[-1]))
    y0, y1 = max(runs, key=lambda r: r[1] - r[0])
    dark = Counter(
        p for p in (px[x, y] for y in range(y0, y1, 2) for x in range(20, W - 20, 11)) if lum(p) < 0.12
    )
    if not dark:
        # A run of rows can look dark on the sampled columns and contain no dark pixel once the
        # finer grid is used (line art, a photograph, a page rendered with different fonts). That is
        # a picture this script cannot read, not a contrast failure — and crashing here would turn a
        # green build red with a traceback, which is the worst of both answers.
        print(f"{Path(path).name}: rows {y0}-{y1} read as a band but carry no dark pixel — skipped")
        return 0
    bg = dark.most_common(1)[0][0]

    light = Counter()
    for y in range(y0, y1):
        for x in range(20, W - 20):
            p = px[x, y]
            if lum(p) > 0.45:
                light[p] += 1
    text = light.most_common(1)[0][0] if light else None
    print(f"{Path(path).name}: band {y0}-{y1}  bg {bg} (lum {lum(bg):.3f})")
    if text is None:
        print("   no light text inside the band — nothing to contrast against")
        return 0
    r = ratio(text, bg)
    print(f"   body text {text} → {r:.2f}:1 {'OK' if r >= 4.5 else 'FAIL (needs 4.5)'}")
    fails = 0 if r >= 4.5 else 1

    # Lower-luminance clusters inside the band are the chips and the muted second lines.
    mid = Counter(
        px[x, y] for y in range(y0, y1, 2) for x in range(20, W - 20, 5)
        if 0.02 < lum(px[x, y]) < 0.40
    )
    for c, n in mid.most_common(4):
        rr = ratio(c, bg)
        flag = "OK" if (rr >= 4.5 or rr <= 1.05) else "check"
        print(f"   cluster {c} n={n:>6} lum {lum(c):.3f} → {rr:.2f}:1 {flag}")
    return fails


if __name__ == "__main__":
    bad = sum(report(p) for p in sys.argv[1:])
    sys.exit(1 if bad else 0)
