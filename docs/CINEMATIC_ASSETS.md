# Cinematic assets — generation recipe

> **Status: not generated.** The footage below was deferred and the credit
> banked; `/explore/decomposition` ships with a CSS substrate instead. Kept as a
> working recipe in case the cinematic is revisited. For the fold scene that
> *did* ship, see `web/public/scene/README.md`.

Reproducible record for the landing page's scroll-scrubbed decomposition footage
(`web/public/cinematic/`). Plan: `docs/LANDING_CINEMATIC_PLAN.md`.

- **Model**: Seedance 2.5 via ElevenCreative (web product, supervised — the API-key MCP has no
  image/video tools)
- **Architecture**: **one single continuous take**, not a chain. Seedance 2.5 generates 30s in a
  single pass, which removes every seam and therefore the entire frame-lock/connector problem.
- **Generation budget**: 1 for the take, the rest held as re-roll headroom.

---

## Settings

Set these in the ElevenCreative Video tab before generating. The defaults visible in the UI are
**not** what we want — three of them need changing.

| Setting | Default shown | Use | Why |
| --- | --- | --- | --- |
| Model | Seedance 2.5 | **Seedance 2.5** ✓ | 30s single-shot is the whole reason this works |
| Aspect | 16:9 | **16:9** ✓ | already correct |
| Resolution | 720p | **highest offered** | stage is ~54vw; 720p is acceptable, more is better. Never upscale afterwards |
| Duration | 4s | **30s** (longest offered) | ← change. 4s cannot carry six beats |
| Sound | On | **Off** | ← change. Audio cannot ride a scroll-scrubbed video — bidirectional seeking desynchronises it |
| Start frame | — | **none** | ← optional and deliberately skipped; see below |
| End frame | — | **none** | an end frame forces the camera to pull back — the top cause of stutter |
| Image / video / audio refs | — | none | not needed for a single take |

### Why no start frame

A start frame exists to lock a *seam* — to make clip *n+1* begin exactly where clip *n* ended. A
single continuous take has no seams, so it has nothing to lock. The opening composition is
controlled by the prompt instead, and the hero's static poster is extracted from **frame 0 of the
finished take**, so it matches by construction. Skipping it also avoids spending a generation on
a still.

---

## Prompt

Paste verbatim into the describe field.

```
Single continuous take. One unbroken camera move, no cuts, no shot changes, no edits. The camera drifts slowly and deliberately forward throughout. Deep warm-charcoal void, near-black background, volumetric haze, one hard warm vermilion key light raking from the left, fine dust motes in the beam. Shallow depth of field, anamorphic, matte machined materials. Slow, weighty, cinematic motion with real mass — nothing snaps or pops.

A single rectangular slab of light, like a pane of frozen film, delaminates layer by layer as the camera pushes into it:

Opening: the camera begins pushing slowly toward the whole, unbroken slab hovering centre-frame.

Then: the slab's front face peels away from itself, opening into a dense stack of hundreds of impossibly thin horizontal strata that fan apart like the pages of a book, each stratum catching the vermilion light along its edge.

Then: one brighter solid plate separates upward and away from the top of the stack, drifting out to hold beside it, rotating very gently as it settles.

Then: a slow cloud of small translucent square planes wells up from behind the slab and drifts into a loose vertical column on the right side of the frame, each plane catching the haze.

Then: the camera drifts laterally to the left, and the parallax reveals that the slab is only one card in a long receding strip of identical slabs, marching away into the haze.

Finally: the camera cranes gently up and back, and the strip widens into a vast grid field of slabs stretching to the horizon; a narrow beam of vermilion light sweeps slowly across the field and isolates a small cluster of them, holding there as the shot settles.

No text, no letters, no numbers, no logos, no user interface, no screens, no people, no captions, no watermarks.
```

The six movements map 1:1 to the six DOM beats (whole → transcript → channel → comments →
playlist → search). The footage carries **no words** — every label, timestamp, endpoint path and
JSON excerpt is real DOM text layered over it. That is deliberate: a video model cannot render a
legible `00:04:12` or valid JSON, and the copy stays editable without re-rendering a frame.

The palette words (charcoal void, vermilion rake light) are chosen to land on the page's own dark
cinematic band, `oklch(18% 0.01 75)`, and the brand accent `oklch(64% 0.19 31)`. If the render
drifts warm or cool, the encode step can grade it back rather than burning a re-roll.

---

## After the take lands

Download to `/tmp/v2c-cinematic/take_raw.mp4`, then everything below is local and free.

```bash
WORK=/tmp/v2c-cinematic
OUT=web/public/cinematic
mkdir -p "$OUT"

# 0. What did we actually get? Never upscale — encode what ffprobe reports.
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,duration,nb_frames \
  -of default=noprint_wrappers=1 "$WORK/take_raw.mp4"

# 1. Encode for scrubbing. The tight GOP is what makes currentTime seeks cheap.
ffmpeg -v error -y -i "$WORK/take_raw.mp4" -an \
  -vf "unsharp=5:5:0.8:5:5:0.0" \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
  -g 8 -keyint_min 8 -sc_threshold 0 -movflags +faststart \
  "$OUT/decomposition.mp4"

# 2. Hero poster = frame 0 of the real take, so the still and the video agree exactly.
ffmpeg -v error -y -ss 0 -i "$OUT/decomposition.mp4" -frames:v 1 "$WORK/poster.png"
cwebp -quiet -q 84 "$WORK/poster.png" -o "$OUT/poster.webp"

# 3. Mobile visual: first ~6s, play-once, no scrubbing. Tighter GOP, smaller frame.
ffmpeg -v error -y -i "$WORK/take_raw.mp4" -an -t 6 \
  -vf "scale=-2:720,unsharp=5:5:0.6:5:5:0.0" \
  -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p \
  -g 4 -keyint_min 4 -sc_threshold 0 -movflags +faststart \
  "$OUT/hero-loop.mp4"

du -h "$OUT"/*
```

Budget check after step 1: if `decomposition.mp4` exceeds ~6 MB, raise `crf` to 22–23 before
touching resolution — the scrub is far more sensitive to GOP length than to bitrate.

---

## Log

Record each generation here so re-rolls are traceable and the budget stays visible.

| # | Date | Settings | Credit cost | Outcome |
| --- | --- | --- | --- | --- |
| — | — | — | — | not yet generated |
