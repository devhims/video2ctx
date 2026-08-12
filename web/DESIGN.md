# Landing page design system

Covers the marketing surface only — `/` and `/explore`. The dashboard is a
separate system (light paper, `--color-dashboard-*` in `tokens.css`) and nothing
here applies to it.

Live direction: **Craft**, at `web/app/_directions/craft.tsx` + `craft.css`.

Every claim below was checked against the code on 2026-08-12. Where the code and
the intent disagree, the disagreement is recorded in §8 rather than smoothed
over.

---

## 1. Where it came from

Four skills, and it is worth knowing which decided what, because they disagree
in places and the disagreements were resolved deliberately.

| Source | What it decided |
| --- | --- |
| **`hallmark`** | Structure: Marquee Hero macrostructure, N2 floating-chip nav, Ft4 typographic colophon. The diversification rule (no two consecutive builds share a nav/footer/macrostructure). The honest-copy rule — no invented metrics, ever. |
| **`emil-design-eng`** | Nearly all motion: the frequency budget, the easing curves, duration tiers, `scale(0.97)` on press, clip-path tabs, blur-masked label swaps, stagger timing, the warning against per-frame custom properties. |
| **`apple-design`** | §1 Response — respond on pointer-down, not release; the same `scale(0.97)` rule, independently. §12 Materials — translucent nav layers over scrolling content, and "dim to focus", which is the flashlight. |
| **`scroll-world`** | Nothing visual. Its encode discipline survives: tight GOP, `+faststart`, and the seam laws behind the crossfade loop. |

`canvasui` was reviewed and **rejected**: its dither components require the
experimental `html-in-canvas` API, which exists to process live DOM. Against a
static image that is an experimental dependency bought for nothing, and its own
fallback is that the effect does not run.

---

## 2. Colour

Craft declares its **own palette locally on `.craft`**, not in `tokens.css`. This
is a deliberate departure from Hallmark's "locked tokens" rule and is discussed
as a known debt in §8.

```
--paper          oklch(15.5% 0.006 75)   near-black, warm
--paper-raised   oklch(19%   0.007 75)   inputs, chips
--ink            oklch(95%   0.006 83)   primary text
--ink-soft       oklch(72%   0.008 82)   body copy
--ink-muted      oklch(56%   0.008 80)   captions, colophon
--rule           oklch(27%   0.008 78)   hairlines
--rule-strong    oklch(36%   0.01  78)   input borders
--accent         oklch(66%   0.19  31)   vermilion, carried from the mark
--accent-ink     oklch(98%   0.006 83)   text on accent
```

Everything is OKLCH. The accent is the one chromatic colour on the page and is
inherited from the brand mark — it is not a free choice.

**The dark page owns the document.** `html:has(.craft)` sets both the background
and `color-scheme: dark`. Without it, overscroll rubber-banding flashes the light
body colour and the scrollbar, form controls and autofill render in the light
scheme on near-black.

---

## 3. Motion

### The organising rule: budget by frequency

From `emil-design-eng`. Before animating anything, ask how often it is seen.

| Seen | Budget | Here |
| --- | --- | --- |
| The primary action | Feedback only, no decoration | The inspect form: 140ms press, nothing else |
| Once per visit | Delight is licensed | Section reveals, staggered result entrance |
| Constant, ambient | Must never compete with the task | The fold scene loop, dimmed and behind a mask |

This is why the input and the scene have opposite motion budgets. Treating the
page as one motion system was the mistake this rule corrected.

### Curves and durations

```
--out      cubic-bezier(0.23, 1, 0.32, 1)     entering, exiting, most UI
--in-out   cubic-bezier(0.77, 0, 0.175, 1)    on-screen movement (the tab clip)
--press    140ms   button feedback
--control  200ms   inputs, tabs, state swaps
--enter    420ms   once-per-visit entrances
--exit     200ms   declared but currently unused — see debt 6
```

**There is no `ease-in` token, deliberately.** It delays the first frame — the
one the user is watching most closely — so it reads as sluggish.

### Non-negotiables

- **Never animate a layout property** — no `padding`, `width`, `height`, `margin`.
  Motion is `transform`/`opacity`; `color`, `border-color` and `clip-path` are
  also used and are fine, as none of them trigger layout.
- **Per-frame writes go directly on the element**, never a custom property on a
  shared parent — that recalculates styles for the whole subtree every frame.
- **Transitions over keyframes** for anything interruptible.
- **Never animate from `scale(0)`.** Start at `0.95`+ with opacity.
- **Never animate the focus ring.** It must appear instantly.
- **Every hover is gated** behind `(hover: hover) and (pointer: fine)`.
- **Reduced motion means gentler, not off.** Opacity survives; movement does not.

---

## 4. Signature components

### The clip-path tab strip (`clip-tabs.tsx`)

The row is rendered twice. The duplicate is styled as if every tab were active,
then clipped to the active tab's box; animating the clip means a label changes
colour *exactly* at the moving edge of the pill. Crossfading two text colours
never lands that cleanly. Used by both the result panel and the code sample —
one tab idiom across the page is most of what makes motion read as designed.

`ResizeObserver` keeps the measurement honest when fonts land late.

### The fold scene and flashlight

- A looping clip rests dim under `.voxel-dimmer` (0.64 desktop / **0.52 touch** —
  touch has no lens to lift it back, so the desktop value would just leave it
  murky).
- The light is a **`backdrop-filter`**, not a second copy of the scene. Two
  `<video>` elements would drift out of sync within seconds.
- Its mask uses **`circle closest-side`**. The default is `farthest-corner`,
  which leaves the mask ~20% opaque at the edge midpoints so the square box
  clips it — visible straight edges. This keyword is load-bearing; do not
  "simplify" it away.
- The mask has nine stops reaching zero at the element edge. A short ramp that
  ends inside the box reads as a hard rim.

### Buttons

`scale(0.97)` on `:active` at 140ms, on every pressable element. Pills
throughout. Where a button changes label (Inspect → Reading, Copy → Copied),
both labels occupy the same grid cell and crossfade under a 2px blur, so the
button never changes width mid-press.

---

## 5. Performance rules that shaped the design

- **Gate expensive things by capability, and mount them from JS.** The fold video
  is *created* by JS behind a pointer/motion/connection check. Rendering it in
  SSR markup and hiding it with CSS would still download it.
- **Encode in a single pass.** An intermediate re-encode cost 60% of the
  bitrate before anything reached the browser and produced visible softness.
- **Trust perceptual comparison over SSIM.** SSIM said an over-compressed encode
  was fine. It was measured against an already-degraded intermediate.
- **Scroll-driven reveals use `animation-timeline: view()`, not
  IntersectionObserver.** Chromium folds an element's own `clip-path` into its
  intersection rect, so a clip-path hide/reveal deadlocks — the property doing
  the hiding prevents its own removal. A view timeline reads layout position.
- **Content is visible by default.** Anything hidden pending JS is a page that
  fails closed.

Current transfer: desktop ~643 KB, phone ~247 KB, phone on saveData/3G or
reduced motion **0 bytes of video**.

---

## 6. Copy

- **No invented metrics.** No adoption counts, no speed multiples, no
  testimonials that were not said. Every number on the page is one the platform
  actually produces.
- **Name the cost, not just the benefit.** `/explore` lists each direction's bet
  *and* what it gives up.
- Plain language over jargon: "What was said" beats "Transcript"; header names
  and response shapes belong in the API reference, not the landing page.

---

## 7. Accessibility

- Scene and flashlight are `aria-hidden` decoration; every word is real DOM.
- The page reads correctly with CSS and JS disabled.
- No scroll-jacking. Scroll is never intercepted.
- `:focus-visible` at 2px accent, 3px offset, never animated.

---

## 8. Known debt

Recorded because it is real, not aspirational. Verified 2026-08-12.

1. **Craft's palette is local, not in `tokens.css`.** It duplicates the token
   *roles* (`--paper`, `--ink`, `--accent`) under different names from the global
   `--color-home-*` set. This breaks Hallmark's locked-token rule and means a
   brand colour change needs editing two places. Lifting the dark palette into
   `tokens.css` as `--color-craft-*` is the fix.
2. **State coverage is partial.** Only one `:focus-visible` rule exists for the
   whole direction (a `:where()` catch-all), and the copy button has no `error`
   state beyond silently doing nothing when the clipboard is denied. The
   8-state component discipline is not met.
3. **`--exit` is declared and never used.** The "exits faster than entrances"
   rule is documented but enforced nowhere. Either apply it to the lens fade-out
   and the beat crossfade, or drop the token.
4. **`--color-stage-*` in `tokens.css` is consumed only by `lens-home.css` and
   `cinematic.css`** — both Decomposition-only. If that direction is ever
   deleted, those tokens go with it.
5. **The fold scene is 720p** upscaled ~1.16x at common desktop widths. Sharpness
   is currently fine because contrast, not resolution, was the real constraint —
   but a wider display will expose it.

Resolved 2026-08-12: the stale `tokens.css` stamp, the missing
`.hallmark/log.json` entries, and the dead `craft-ways-band` class.

---

## 9. Changing this safely

- Keep the resting-scene dimming and the `Flashlight` mount conditions **in
  step**. The scene is only darkened where a light exists to recover it; dim it
  anywhere the component does not mount and the fold is simply dark.
- Promoting a different landing direction is one line: `DEFAULT_DIRECTION` in
  `_directions/registry.tsx`.
- Regenerating the fold scene: prompts, settings and encode commands are in
  `docs/CINEMATIC_ASSETS.md` and `web/public/scene/README.md`.
- Verify motion work **on a real device**. Headless Chrome does not enforce
  autoplay policy — a mobile video bug shipped past a green emulator check
  because React's `muted` prop does not reliably reach the DOM property on a
  dynamically created `<video>`.
