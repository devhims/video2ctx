# Landing page: layout modernisation + scroll-driven decomposition cinematic

> **Outcome (2026-08-12): neither direction in this document shipped.** The
> exploration it set up produced a third, "Craft" — a Marquee Hero whose fold is
> the inspect form, now live at `/`. The scroll cinematic described below exists
> at `/explore/decomposition` as a contender, and the Seedance footage was never
> generated. Read this as the record of how the decision was reached, not as a
> description of the current homepage.
>
> **Superseded as *the* plan (2026-08-12).** What this document describes is now
> **one contender of several**, living at `/explore/decomposition`, not the agreed
> design. It was committed to far too early: the method's one divergence point —
> *offer several categorically different macrostructures when the brief is vague* —
> was collapsed into a single pick, and the design-context gate (audience, use
> case, tone) was inferred from the codebase instead of asked. Inferring
> "developer API" from the code is what produced the API-only framing that had to
> be corrected later. Three rounds of corrective feedback were the cost.
>
> The work is not discarded — the audit in §1 is direction-independent and still
> valid, as are the token scale and the scrub engine. But the *composition* is now
> subject to an exploration phase: brief → reference study → several live
> directions at `/explore` → pick one → promote.
>
> **Brief, as stated by the user rather than inferred:**
> - **Audience:** developers wiring up an agent
> - **Primary action:** inspect a video right there — the paste-a-URL demo is the
>   conversion moment, which makes it a centrepiece rather than a hero accessory
> - **Brand:** open to change; Geist + vermilion + light paper was inherited, never
>   chosen
> - **Tone:** deferred until the reference study, which will imply it better than
>   an adjective picked in advance

Status: **plan, pending approval.** Supersedes `web/app/_components/landing-prototype-NOTES.md`
(that file's verdict was "pending user review" — this plan closes it by promoting variant C's
information model and deleting A and B).

Design method: Hallmark (audit → redesign), with motion/perf rails from
`high-end-visual-design` and the render pipeline from the `scroll-world` skill.

**Decisions locked (2026-08-11):**

- **Render biller: ElevenCreative** (existing ElevenLabs credits) — a *supervised
  export/import* backend, see §3.3
- **Mobile: static poster + stacked list** — no scrub chain on phones, no portrait render
- **Scope: full seven-section rebuild**
- **Footage: deferred, not cancelled.** The remaining ElevenLabs credit covers exactly **one 20s
  generation with zero re-roll headroom**, which is a poor bet on a first-attempt render, and its
  value cannot be judged before the band exists. The cinematic ships with a **CSS/SVG stage**
  instead; the footage stays a drop-in upgrade behind the same stage element and the same scroll
  contract. Rationale and the reduced 3-movement prompt: §3.7.
- **Model if/when it is generated: Seedance 2.5** (confirmed available in ElevenCreative), one
  single continuous take — never a frame-locked chain, which cannot fit the budget. Recipe:
  `docs/CINEMATIC_ASSETS.md`.
- **Keyframe stills: not generated.** Codex `image_gen` is unavailable in this environment (the
  code-mode host is not installed), and a single take needs no start frame anyway.

---

## 0. Pre-flight findings

- **Framework**: Next.js 16 app router, React 19 (`web/package.json`)
- **Fonts**: Geist Sans + Geist Mono + Geist Pixel Grid via `geist` (`web/app/layout.tsx:2-4`)
- **Palette**: OKLCH custom properties, light paper + vermilion accent (`web/tokens.css:5-109`)
- **Motion libraries**: none installed — this is a **motion-cut project**. All motion is hand-authored CSS.
- **Spacing**: `--space-3xs … --space-4xl` scale (`web/tokens.css:28-37`)
- **Existing Hallmark stamp**: `macrostructure: Map / Diagram · tone: technical-austere · anchor hue: vermilion`
- **Project memory**: `.hallmark/log.json` — last four builds were Workbench, Map/Diagram ×3;
  navs N9 ×3 and N3; footers Ft2 ×3

**Preserve**: font stack, OKLCH palette, spacing scale, vermilion accent, the URL-inspect form.
**Introduce**: new macrostructure, second lightness band, nav/footer archetypes, the cinematic.
**No new runtime dependencies** — the scrub engine is ~120 lines of vanilla TS.

---

## 1. Audit — what's holding the page back

Ranked by impact.

### 1.1 The page is three sections deep and never shows the product surface
Production ships nav → hero → `agent-premise` → footer (`web/app/page.tsx`). For a developer
API that is missing: the shape of the response, a request you can copy, the endpoint index,
pricing, auth. Two of the five surfaces the product actually exposes — **playlist** and
**search** — appear nowhere in the shipping variant. `docs/UI_API_REFERENCE.md` lists twelve
routes; the landing page names zero of them.

### 1.2 The orbit diagram carries no information and the metaphor is wrong
Four concentric rings spin for 36s with counter-rotating labels (`lens-home.css:263-405`).
Orbit says *satellites circling a body*. The actual product claim is *one video separates into
addressable parts*. Decomposition, not orbit. It is also pure decoration — hovering pauses it,
which is a nice touch on top of a zero-payload animation.

### 1.3 The hero spends its largest type on the brand name
`h1` is the literal string `video2ctx` in Geist Pixel Grid at up to 5.5rem in accent red
(`lens-home.css:102-114`), directly above a 2.6rem/675 tagline. Two competing display
statements, and the nav already says the wordmark twice (mark + text). Meanwhile the single
best line on the page — *"A video is more than a transcript."* — is an `h2` below the fold
(`page.tsx:23`). The claim should be the `h1`; the wordmark belongs in the nav.

### 1.4 Five rungs before the interaction
`h1` → tagline → lede → form label → quota note → input. The form label ("Try a public YouTube
video") restates the lede. Collapse to: eyebrow → claim → one lede → input.

### 1.5 Nav is the most-recognisable AI shape
N1a: wordmark left, one pill right (`lens-home.css:38-82`). No docs, no reference, no pricing,
no repo. Also the fourth consecutive build on an N9/N1a-family nav per `.hallmark/log.json`.

### 1.6 One shadow idiom on five different components
`box-shadow: <offset> <offset> 0 <ink>` appears on the input card, source nodes, the core, the
engine slab, and the inspection shell (lines 142, 312, 372, 734, 979). When every component
shares the signature, nothing reads as more important than anything else.

### 1.7 The whole page sits in one lightness band
Paper 96.5%, raised 98.5%, muted 93%. Hierarchy therefore rests entirely on 1px rules. There is
no dark surface anywhere, which is also why there is currently nowhere for a video to live.

### 1.8 Two grids and a wash fighting each other
`main` carries a page-wide dot grid **plus** a radial accent wash (`lens-home.css:4-7`); the
orbit adds a second grid at a different scale (`:251-261`); the engine variant adds a third in
perspective (`:551-563`). Generic texture applied globally is an AI tell; here it is applied
three times at once.

### 1.9 The conversion moment hands over nothing
After a successful inspect the user is looking at their own video's transcript and comments —
the strongest moment on the page — and gets one text link (`landing-demo.tsx:548-550`). No
`curl`, no JSON, no "this is the request that produced this."

### 1.10 Dark mode is tokens without a design
`prefers-color-scheme: dark` remaps twelve variables (`tokens.css:111-126`). The composition
was built for light paper: hard ink offset-shadows are invisible on dark paper, and the accent
wash inverts badly.

### 1.11 LCP is behind hydration
The entire hero — headline, tagline, lede — renders inside `'use client'`
(`landing-demo.tsx:1`). Only the form and the video stage need to be client components.

### 1.12 Mobile hero can push the input below the fold
`min-height: calc(100svh - 4rem)` plus a 26rem stage (`lens-home.css:1499-1542`) leaves the
input card off-screen on short phones.

### 1.13 Dead code and undecided prototypes shipping
Three hero variants, a keyboard switcher, and ~700 lines of orbit/engine CSS are in the tree.
`--text-display` is defined and never used.

---

## 2. The redesign

### Hallmark picks

| Axis | Pick | Differs from last build on |
| --- | --- | --- |
| Genre | modern-minimal (developer API / platform signal) | — |
| Macrostructure | **16 · Feature Stack** — sticky copy rail + scroll-synced stage | was Map/Diagram, Workbench |
| Theme | existing-brand-DNA (light paper · vermilion · Geist) — preserved per pre-flight | — |
| Nav | **N10 · Floating-on-scroll morph** | was N9 ×3, N3 |
| Footer | **Ft5 · Statement** | was Ft2 ×3 |
| Enrichment | **E-video** — scroll-scrubbed generated footage (Seedance 2.0) + DOM overlay | was Tier-A CSS, none |
| Motion primitives | 3 exactly: scroll-scrub · beat crossfade · button press | — |

Feature Stack is the load-bearing choice: its native shape *is* a sticky statement beside a
scroll-synced stage, which is exactly the mechanic the cinematic needs. The macrostructure and
the animation are the same decision.

### New section order

1. **Nav (N10)** — bar at rest with `Docs · API reference · Pricing · Changelog` + filled
   `Get an API key`. Past the fold it morphs into a floating pill so it stops competing with
   the dark cinematic band.
2. **Hero** — 7/5 asymmetric. Eyebrow `YouTube Agent API`. `h1` = *"A video is more than a
   transcript."* One lede line. The URL input (kept as-is — it is the page's best asset).
   A hairline proof strip: `5 free inspections · no key required`. Right column: the
   cinematic's first frame as a still slab + `scroll to take it apart ↓`.
3. **The cinematic** — five folds, dark band. Section 3 below.
4. **Live proof** — the existing inspect result, plus the `curl` that produced it, a copy
   button, and raw JSON in a `<details>`. Fixes 1.9.
5. **Surface index** — the twelve routes from `docs/UI_API_REFERENCE.md` as a real scannable
   index, grouped video / channel / playlist / search / transcript / comments. Fixes 1.1.
6. **Honest facts band** — replaces the `Input / Output / Built for` spec sheet with facts we
   actually hold: rolling 24h quota, `X-Request-Id` on every response, source links on every
   field, transcript language codes, and the explicit "transcript may be unavailable" caveat.
   **No invented metrics** — no "trusted by N teams", no "10× faster". Hallmark gate 46.
7. **Footer (Ft5)** — one display sentence + wordmark + Privacy/Terms in muted small type.

### Visual system changes

- **Type**: `h1` moves to Geist Sans 725 at `--text-display` (currently defined, unused).
  Geist Pixel Grid retires to the wordmark and section eyebrows only — it is a brand accent,
  not a display face. One display statement per fold, never two.
- **Second lightness band**: the cinematic sits on `oklch(18% 0.01 75)`. The page gains a real
  light → dark → light rhythm, and the generated footage gets a surface that looks intentional
  rather than pasted on.
- **Surfaces**: double-bezel instead of five identical hard shadows — hairline ring, a ~6px
  tray, concentric inner radius (`calc(outer - tray)`), one diffused ambient shadow. Exactly
  one element keeps the hard offset shadow: the input card, as the brand's signature.
- **Texture**: page-wide dot grid and accent wash removed. One texture, scoped to the dark band.
- **Dark mode**: designed, not remapped — the dark band means half the work is already done.
- **Motion budget**: three primitives, hard cap. The 36s orbit spin and the 6.5s scanner sweep
  are deleted with their variants.

---

## 3. The scroll-driven cinematic

### 3.1 The one architectural decision that matters

**Seedance renders the physical substrate. The DOM renders every word.**

Generated video cannot produce legible `00:04:12`, a real `@handle`, or valid JSON — it will
produce convincing-looking garbage, which is worse than nothing on a developer landing page.
So the split is absolute:

- **Video layer** — a slab of footage travelling through a light plane and delaminating into
  translucent strata. Cinematic, physical, wordless. Every prompt ends with
  `No text, no letters, no numbers, no logos, no UI` (the same rule `scroll-world` applies to
  its stills).
- **DOM layer** — the five labels, the endpoint paths, the timestamps, the JSON excerpts, the
  links. Real text: selectable, indexable, screen-reader legible, crisp at any DPR, and
  re-writable without re-rendering a single frame.

This is also the risk control: copy and video can be iterated independently.

### 3.2 Shot list — five beats, one continuous forward camera

**One single continuous 30s take** — Seedance 2.5's single-pass 30s mode, so the six beats are six
*movements within one shot*, not six clips. Pinned to ~7vh of scroll. Because there is no seam
anywhere, the camera is free to reverse mid-shot (the closing crane-up is safe), and none of the
chain apparatus applies: no start frames, no end frames, no connectors, no frame extraction, no
frame-lock probe, no sequential render order, no seam crossfade.

| Beat | Movement within the take (wordless) | DOM overlay | Endpoint |
| --- | --- | --- | --- |
| 0 → 1 **Transcript** | Camera pushes into a solid glowing slab of footage; the front face peels away as a dense stack of thin horizontal strata | Timestamped segment rows, real `mm:ss` values | `GET /v1/providers/youtube/videos/:id/transcript` |
| 2 **Channel** | An identity plate separates upward and holds beside the slab | Channel card: name, handle, source link | `GET /v1/providers/youtube/channels/:id` |
| 3 **Comments** | A cloud of small translucent planes emerges from behind the slab and drifts into a column | Comment cards with pinned/hearted/like state | `GET /v1/providers/youtube/videos/:id/comments` |
| 4 **Playlist** | Camera drifts laterally; the single slab is revealed as one card in a long receding strip | Playlist strip with position indices | `GET /v1/providers/youtube/playlists/:id` |
| 5 **Search** | Camera lifts and pulls back; the strip becomes one row in a wide field of slabs, then a narrowing beam isolates a few | Query pill + result rows | `GET /v1/providers/youtube/search` |
| Finale | The field re-collapses toward the original slab | The five parts snap into one JSON object + `Get an API key` | — |

Left sticky rail per beat: beat number, label, the endpoint path in mono, one line of copy, a
three-line JSON excerpt. Right: the video stage.

**Seedance 2.5 confirmed available (2026-08-11)**, so this is the path taken. The residual risk is
no longer seams — it is whether ElevenCreative's duration selector actually offers 30s (the UI
defaults to 4s). If the ceiling is lower, see §6.1.

### 3.3 Render pipeline — ElevenCreative (supervised)

Reuses `~/.claude/skills/scroll-world/references/pipeline.md` with our own prompts, on the
ElevenCreative path documented in that skill's `references/elevenlabs.md`.

**Read this first: ElevenCreative is not automatable.** As of the skill's 2026-08-04 check, the
official API-key MCP (`elevenlabs-mcp` v0.12.1) exposes speech, music, and sound effects only —
no image or video generation — and the public API has no Image & Video endpoint. The hosted MCP
is agents + TTS. So the video legs are generated **by you, in your authenticated ElevenCreative
session**, and downloaded to exact filenames. I do everything on either side of that: prompts,
keyframes, frame extraction, encoding, wiring, QA. I will not invent MCP tool names or
reverse-engineer private web endpoints to fake automation.

Division of labour — **one generation, not six**:

| Step | Who | Cost |
| --- | --- | --- |
| 1. Prompt + exact UI settings | me — done, `docs/CINEMATIC_ASSETS.md` | $0 |
| 2. Generate the single 30s take, download to `/tmp/v2c-cinematic/take_raw.mp4` | **you** | 1 generation |
| 3. Encode, poster, mobile loop, wire, QA | me | $0 |

Notes:

- **Sound off.** Audio cannot ride a scroll-scrubbed video — arbitrary bidirectional seeking
  desynchronises it. The UI defaults to On; it must be changed.
- **No start or end frame.** A start frame locks a seam, and there are no seams. An end frame is
  actively harmful — it forces the camera to pull back toward the target composition.
- **Costs must be read, not extrapolated.** ElevenCreative's displayed per-generation credit cost
  is the only valid number; fal's and Monid's per-second prices do not convert to ElevenLabs
  credits and are not used. Record it in the log table of `CINEMATIC_ASSETS.md`.
- **Re-roll policy.** Four generations in reserve. Spend them on prompt adjustments, not on
  resolution or duration changes — and grade colour in the encode rather than burning a re-roll
  on palette drift.

`ffmpeg`, `ffprobe`, and `cwebp` are installed and verified. `codex` is installed but its
`image_gen` is **not functional here** (the code-mode host binary is missing), which is moot now
that no start frame is needed. `monid` and `higgsfield` are not installed and are not needed.

### 3.4 Engine

Port the **scrub core only** out of `scroll-world/references/scrub-engine.js` into
`web/app/_components/scroll-scrub.ts` (~120 lines):

- scroll offset → normalised `currentTime` mapping across the pinned band (simpler than
  `scroll-world`'s segment chain — one clip, so no segment index and no crossfade needed)
- Blob loading — guarantees seekability without depending on HTTP range support
- **seek coalescing** — never issue a new `currentTime` while the decoder reports `seeking`;
  this is what stops fast flicks from freezing the video
- iOS priming — muted `play()` → `pause()` on first touch, or the first frame paints blank
- per-beat `linger` remapping, so the camera settles exactly where each beat's copy peaks instead
  of sliding past it at constant speed

Do **not** mount its DOM builder or injected CSS — it ships its own layout and would fight the
design system. React renders the DOM; the port owns the decoder discipline.

Overlay layers use native CSS scroll-driven animations (`animation-timeline: view()`), gated
behind `@supports`, falling back to an `IntersectionObserver` `.is-visible` class. No
`scroll` event listener drives layout — the video scrub reads scroll in a passive listener that
only writes a variable, consumed on `requestAnimationFrame`.

### 3.5 Performance budget

- **Desktop**: one ~30s file at 720p+ crf20 `-g 8` → est. **3–6 MB**, a single request instead of
  five. Budget ceiling 6 MB; if it exceeds that, raise `crf` to 22–23 before touching resolution —
  scrub smoothness depends on GOP length far more than on bitrate. Poster ~60 KB.
  `content-visibility: auto` on the band, and the file is fetched only once the hero is scrolled
  past — it is never on the critical path.
- **LCP**: hero headline, lede, and form server-rendered (fixes 1.11). The cinematic mounts
  after hydration and is never the LCP element.
- **Mobile — no scrubbing (decided).** Scrubbing five clips across a phone decoder is the primary
  source of jank, and a phone user wants the input form, not a 12 MB cinematic. Phones get a
  single ~6s play-once loop as the hero visual (re-encoded from leg 1, no extra generation) and
  the five beats as a plain stacked list with scroll-driven reveals. No native 9:16 chain, no
  centre-crops, no `-m.mp4` variants, no `clipMobile`/`stillMobile` wiring. The scrub engine
  mounts only above 860px and on fine pointers; below that the beats are static DOM that already
  works. Saves the ~2× render spend and removes the biggest QA surface.
- **`prefers-reduced-motion: reduce`**: no video, no seeking. Static poster of the fully
  delaminated frame + the five beats as a static list.
- Animate `transform`/`opacity` only. `backdrop-blur` on the morphing nav only, never on the
  scrolling band.

### 3.6 Why the substrate is CSS, and what would change if it were footage

The DOM already carries every word, so the generated clip was only ever the *substrate* — the
smaller half of the job. Weighed honestly against a CSS/SVG stage for **this** subject:

| | CSS/SVG stage | Generated footage |
| --- | --- | --- |
| Weight | ~20 KB | 3–6 MB |
| Iteration cost | free, instant | one generation each |
| Palette | the actual `--color-home-accent` token | approximated, graded in the encode |
| Sharpness | vector, exact at any DPR | fixed raster, softens on retina |
| Subject fit | rectangles, strata, cards, grids — inherently graphic | wins on photoreal physicality, which this subject does not need |
| Risk | none | one shot, no re-rolls, unfixable if the delamination reads as mush |

Generated video earns its keep when the subject is *photographic* — a diorama world, a physical
product, a place. A video decomposing into transcript segments, a channel, a playlist and search
results is a diagram. So the CSS stage is the primary build, not a placeholder for one.

The footage remains a genuine upgrade path for atmosphere — haze, dust, anamorphic falloff and
volumetric light are things CSS cannot fake convincingly. If it is generated later, the swap is:
add `<video>` inside the existing stage element, pass `video`/`src` to `mountScrub`, delete the
CSS substrate layer. The beats, copy, scroll contract, and engine are untouched.

### 3.7 The reduced prompt, if the credit is spent after all

Six movements do not fit in 20s. Keep only the three where footage beats CSS, and let DOM own the
rest:

1. Camera pushes into the whole slab.
2. The front face delaminates into a dense stack of thin strata.
3. The camera cranes up and back to reveal the field of slabs.

Channel, playlist and search then play as DOM beats over a near-held tail of the shot — the
engine's `linger` remap stretches 20s across the full band without reading as slow motion, because
it decelerates into each beat rather than gliding at constant speed. Settings otherwise unchanged
from `docs/CINEMATIC_ASSETS.md`: 16:9, highest resolution offered, **sound off**, no start or end
frame.

### 3.8 Accessibility

- Video is `aria-hidden` decoration; the DOM overlay is the content. Nothing is conveyed by
  footage alone.
- The five beats are a real `<ol>` with real headings — the page reads correctly with CSS and
  JS disabled, and each beat's endpoint is a real link into the docs.
- Scroll-jacking: none. Scroll distance maps linearly to clip time; native scrolling is never
  intercepted, so keyboard, trackpad, and screen-reader navigation all behave normally.
- Focus order follows DOM order, unaffected by the sticky rail.

---

## 4. Files

**Modify**
- `web/app/page.tsx` — server-rendered hero + the seven section shells
- `web/app/_components/landing-demo.tsx` — strip to `InspectForm` + `InspectionResult`; delete
  `OrbitHero`, `SignalFieldHero`, `ContextEngineHero`, `OrbitMap`, `SourceNode`,
  `ContextEngineStage`, `EngineOutput`, `PrototypeSwitcher`
- `web/app/lens-home.css` — ~700 lines of orbit/engine CSS become dead; split page CSS from
  cinematic CSS
- `web/tokens.css` — dark-band, ambient-shadow, and concentric-radius tokens; re-stamp the
  macrostructure comment
- `.hallmark/log.json` — append the new entry

**Add**
- `web/app/_components/decomposition-cinematic.tsx` — the five-beat stage (client)
- `web/app/_components/scroll-scrub.ts` — ported scrub core
- `web/app/_components/request-preview.tsx` — curl + JSON + copy button
- `web/app/cinematic.css`
- `web/public/cinematic/{beat1..5}.mp4` + `{beat1..5}.webp` (desktop scrub chain + posters)
- `web/public/cinematic/hero-loop.mp4` — ~6s play-once mobile visual, re-encoded from leg 1, no
  extra generation
- `docs/CINEMATIC_ASSETS.md` — prompt text, model, settings, per-clip credit cost, and the ffmpeg
  commands, so the chain is reproducible and re-rollable without re-deriving any of it

**Delete**
- `web/app/_components/landing-prototype-NOTES.md` (decision closed by this plan)

---

## 5. Phasing

**Phase 1 — zero render spend.** Restructure the page, apply the design system, and build the
cinematic band driven by real scroll-scrub with the *existing* CSS-3D engine stage as the
placeholder. This ships a materially better page on its own and proves the scroll choreography,
pacing, copy, and perf budget before any money is spent. If the choreography is wrong, it is
wrong here, cheaply.

**Phase 2 — the take.** Prompt and settings are ready in `docs/CINEMATIC_ASSETS.md`. You generate
one 30s clip and download it; I encode, poster, and wire it. Runs **in parallel with Phase 1** —
nothing in Phase 1 depends on the footage existing, because the placeholder occupies the same
stage with the same scroll contract.

**Phase 3 — finish.** Designed dark mode, mobile stacked-list pass, delete the dead variants and
~700 lines of orphaned CSS, Hallmark 58-gate slop test, re-stamp `tokens.css`, append
`.hallmark/log.json`.

No probe stage and no previz stage on this path. Probes exist to verify seams; a single take has
none. Previz existed to de-risk an automated chain cheaply; with one supervised generation it would
cost the same as the real thing. Phase 1's placeholder covers the remaining risk better anyway —
it proves the choreography on the real page before a single credit is spent.

---

## 6. Decisions taken, and what's still unknown

**Taken (2026-08-11):** ElevenCreative as the biller · Seedance 2.5, single 30s take · static
poster + stacked list on mobile · full seven-section rebuild.

Open, and answerable from the ElevenCreative UI. None of these block Phase 1:

1. **What is the real duration ceiling?** The UI defaults to 4s. Seedance 2.5 advertises 30s
   single-pass, but ElevenCreative may cap lower. This is the one genuine risk left:
   - **30s available** → plan proceeds exactly as written, 1 generation.
   - **~10–15s ceiling** → compress the six movements into ~15s and pin it to a shorter band
     (~4vh). Tighter pacing, still one generation, still seamless. Preferred over chaining.
   - **Still 4–5s** → the single-take architecture is dead; fall back to a frame-locked chain,
     which needs ~5 generations and leaves no re-roll headroom against a 5-generation budget.
     At that point the honest recommendation is to ship Phase 1's DOM-only cinematic and revisit
     the footage when the quota resets.
2. **Is a resolution above 720p offered?** 720p is acceptable for a ~54vw stage, so this is an
   upgrade, not a blocker. Never upscale after the fact.
3. **What does "5 left" actually count?** Whether it is a rolling/daily allowance or a hard
   remaining balance decides how much re-roll freedom exists, and whether Image-tab generations
   draw from the same pool.
4. **Kling 3.0 as the fallback model** if the prompt keeps tripping a content filter — different
   filter, also capable of a continuous take.

---

## Sources

- [Seedance 2.0 on fal](https://fal.ai/seedance-2.0) — pricing tiers, API access
- [Seedance 2.0 API guide, NxCode](https://www.nxcode.io/resources/news/seedance-2-0-api-guide-pricing-setup-2026) — parameters, duration and resolution limits
- [Seedance 2.5 API goes live, CineD](https://www.cined.com/bytedance-seedance-2-5-api-goes-live-30-second-single-shot-clips-50-reference-inputs-and-3d-camera-blockouts/) — 30s single-shot, 3D camera blockouts
- [ElevenLabs image & video capabilities](https://elevenlabs.io/docs/overview/capabilities/image-video) — what ElevenCreative exposes
- [elevenlabs-mcp](https://github.com/elevenlabs/elevenlabs-mcp) — confirms the API-key MCP is audio-only, hence the supervised workflow
- `~/.claude/skills/scroll-world/` — pipeline, seam law, scrub engine
- `~/.claude/skills/hallmark/` — macrostructure, nav/footer archetypes, slop test
- `~/.claude/skills/high-end-visual-design/` — double-bezel, motion and perf rails
