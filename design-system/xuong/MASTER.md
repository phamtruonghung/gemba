# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** Xuong
**Generated:** 2026-10-11 12:31:07
**Category:** General
**Design Dials:** Variance 5/10 (Balanced / Modern) | Motion 2/10 (Subtle) | Density 6/10 (Standard)

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Brand / Accent / CTA | `#EA580C` | `--color-accent` |
| On Accent/CTA | `#1A0D03` | `--color-on-accent` |
| Accent hover / pressed | `#C2410C` | `--color-accent-hover` |
| Accent as text (links) | `#9A3412` | `--color-accent-ink` |
| Accent tint (soft fills) | `#FFF1E6` | `--color-accent-tint` |
| Background (warm paper) | `#F7F4F1` | `--color-background` |
| Foreground (ink) | `#0B1A1D` | `--color-foreground` |
| Card | `#FFFFFF` | `--color-card` |
| Muted | `#F1ECE6` | `--color-muted` |
| Muted Foreground | `#5B5A57` | `--color-muted-foreground` |
| Border | `#E7E1DA` | `--color-border` |
| Graphite (structure, refusals) | `#334155` | `--color-graphite` |
| Dark band | `#1A1614` | `--color-band` |
| Destructive | `#B91C1C` | `--color-destructive` |

**Color Notes:** Orange is the brand colour — the generated system had it as an accent beside industrial
grey #64748B; the product's own decision is that orange *is* the theme, so it carries the primary action,
the brand mark, the tint fills and the dark band's highlight. The neutral moved from cool slate to a warm
paper pair (`#F7F4F1` / `#0B1A1D`) to sit with it. Graphite `#334155` is kept for structure and for the
refusal panel — a refusal must not be mistaken for the brand's own accent, and it must not read as an
error either. Every pair above was measured at 4.5:1 or better on the rendered page in both themes.

**Dark mode:** `#141110` background, `#1D1917` cards, accent `#FB923C` with `#1A0D03` text, accent-as-text
`#FDBA74`. Driven by `prefers-color-scheme`, overridden in one token block.

### Typography

- **Heading Font:** system UI stack (`Segoe UI Variable Text`, `Segoe UI`, `system-ui`, …)
- **Body Font:** the same stack
- **Mood:** geometric, modern, clean, balanced — the *scale and tracking* are borrowed from the
  structure reference (a display sans at ~64px/500 with -0.03em tracking and a 0.98 line-height for h1),
  not the font file.

**No webfont request, on purpose.** The generated pairing (Outfit + Work Sans) and the reference's Geist
both need `fonts.googleapis.com`; this app runs as an appliance on a factory LAN and behind a tunnel, so a
third-party request on every page load is a blank flash and a dependency. See the header comment in
`src/views.mjs`. If a webfont is ever wanted, self-host the woff2 in the repo rather than link Google.

### Structure reference

The page shape follows `arbolus.com`, read with `scripts/read-reference.py` (outline, computed styles,
screenshots) rather than copied by eye:

1. thin dark utility bar — one status on the left, account links right
2. light nav bar — logo left, nav pills, one filled CTA right
3. centred hero — small uppercase stat row, very large headline (breaks to two lines), lead, one button
4. the product's primary action — the ask form in a single card, max-width 820px
5. a three-column feature row divided by hairlines, each with a small uppercase pill tag
6. a two-column block: prose + outline button on the left, a framed example on the right, with stat cards
7. a full-width **dark band** carrying the profile cards (the reference's carousel section, as a grid)
8. a four-card grid — the four rungs
9. a two-column money block: text left, a tinted panel with a tilted mockup card right
10. a three-card quote row — what a refusal sounds like, from the real corpus
11. a three-card "who it is for" row
12. a resource-card grid — the published notes, with topic tag and reading time
13. a closing dark CTA band
14. a four-column footer plus a legal/prototype base row

### Typography and spacing, as rendered

- h1 `clamp(38px, 6.2vw, 64px)`, weight 600, tracking -0.03em, line-height 0.98
- h2 `clamp(26px, 3.4vw, 42px)`, weight 600, tracking -0.02em
- lead `clamp(17px, 1.6vw, 20px)` in muted foreground
- eyebrow: 12px, weight 650, tracking 0.14em, uppercase
- sections: 64px vertical rhythm (88px for the hero), 1200px container, 820px for reading-width pages
- cards: 16px radius, 1px border, 24px padding; buttons are pills at 46px minimum height

### Spacing Variables

*Density: 6/10 — Standard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `4px` / `0.25rem` | Tight gaps |
| `--space-sm` | `8px` / `0.5rem` | Icon gaps, inline spacing |
| `--space-md` | `16px` / `1rem` | Standard padding |
| `--space-lg` | `24px` / `1.5rem` | Section padding |
| `--space-xl` | `32px` / `2rem` | Large gaps |
| `--space-2xl` | `48px` / `3rem` | Section margins |
| `--space-3xl` | `64px` / `4rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

### Buttons

```css
/* Primary Button */
.btn-primary {
  background: #EA580C;
  color: white;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}

.btn-primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

/* Secondary Button */
.btn-secondary {
  background: transparent;
  color: #64748B;
  border: 2px solid #64748B;
  padding: 12px 24px;
  border-radius: 8px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}
```

### Cards

```css
.card {
  background: #F8FAFC;
  border-radius: 12px;
  padding: 24px;
  box-shadow: var(--shadow-md);
  transition: all 200ms ease;
  cursor: pointer;
}

.card:hover {
  box-shadow: var(--shadow-lg);
  transform: translateY(-2px);
}
```

### Inputs

```css
.input {
  padding: 12px 16px;
  border: 1px solid #E2E8F0;
  border-radius: 8px;
  font-size: 16px;
  transition: border-color 200ms ease;
}

.input:focus {
  border-color: #64748B;
  outline: none;
  box-shadow: 0 0 0 3px #64748B20;
}
```

### Modals

```css
.modal-overlay {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.modal {
  background: white;
  border-radius: 16px;
  padding: 32px;
  box-shadow: var(--shadow-xl);
  max-width: 500px;
  width: 90%;
}
```

---

## Style Guidelines

**Style:** Minimalism & Swiss Style

**Keywords:** Clean, simple, spacious, functional, white space, high contrast, geometric, sans-serif, grid-based, essential

**Best For:** Enterprise apps, dashboards, documentation sites, SaaS platforms, professional tools

**Key Effects:** Subtle hover (200-250ms), smooth transitions, sharp shadows if any, clear type hierarchy, fast loading

### Page Pattern

**Pattern Name:** Hero + Features + CTA

- **Conversion Strategy:** Deep CTA placement. For CTA label text, verify at least 4.5:1 against the button fill; use 7:1 only when the product explicitly targets AAA normal-text contrast. Keep focus and component boundaries independently visible. Disable hero parallax under reduced motion and render its static final state.
- **CTA Placement:** Hero (sticky) + Bottom
- **Section Order:** Hero with headline/image > Value prop > Key features (3-5) > CTA section > Footer

---

## Motion

**Scroll Reveal** (Subtle) — Trigger: scroll (viewport enter) | Duration: 300-400ms | Easing: `power1.out`

```js
gsap.from(el, { opacity: 0, y: 12, duration: 0.35, ease: 'power1.out', scrollTrigger: { trigger: el, start: 'top 90%', toggleActions: 'play none none reverse' } });
```

**Framework notes:** Requires the ScrollTrigger plugin registered once via gsap.registerPlugin(ScrollTrigger); Use matchMedia('(prefers-reduced-motion: reduce)') to skip non-essential motion and render the final state immediately

- ✅ Keep the y offset small (8-16px) so it reads as a fade, not a slide
- ❌ Don't reveal below-the-fold content needed for SEO/crawlers as invisible-by-default without a no-JS fallback
- ⚡ toggleActions 'play none none reverse' avoids re-triggering on every scroll direction change

---

## Anti-Patterns (Do NOT Use)


### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
