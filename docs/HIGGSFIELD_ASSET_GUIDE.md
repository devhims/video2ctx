# Generating video assets with Higgsfield

Written from the session that produced the landing hero loop
(`web/public/scene/fold-scene.webm`). Six renders, ~166 credits, and four
failures worth not repeating.

The prompts are the least transferable part of this document. The **measurement
harness** in §5 is the most — it is what turns "does this look right?" into a
number, and it is why the fourth attempt was recognisably better than the third
rather than just different.

---

## 1. Setup

```bash
higgsfield account status          # if this fails: higgsfield auth login (interactive)
higgsfield workspace list          # note the id and the credit balance
higgsfield workspace set <id>      # REQUIRED — `generate cost` fails without it
```

Selecting a workspace is easy to miss. Every cost and generate call returns
`No workspace selected` until you do it.

## 2. Always price before you render

```bash
higgsfield generate cost seedance_2_0 \
  --prompt "t" --start-image ./still.png \
  --duration 8 --resolution 720p --mode std --generate_audio false
```

Measured on a Pro plan, 2026-08:

| Model | 5s 720p | 8s 720p | 5s 1080p | 10s 1080p |
| --- | --- | --- | --- | --- |
| `seedance_2_0_mini` | 12.5 | — | n/a | n/a |
| `seedance_2_0` | 22.5 | 36 | 45 | 90 |
| `seedance_2_5` | 32.5 | — | n/a (720p cap) | n/a |

Cost scales with duration and resolution, so a longer clip you intend to trim is
cheap insurance compared with re-rolling a short one.

## 3. Choosing a model

- **`seedance_2_0` is the default.** Reaches 1080p/4K, takes `--start-image` and
  `--end-image` directly.
- **`seedance_2_0_mini` for previz.** Half the cost, same behaviour. Use it to
  prove a prompt produces motion at all before paying for the real render.
- **`seedance_2_5` is not "newer therefore better."** It caps at **720p**, and it
  only accepts a start frame under `--mode omni_reference` — the default `t2v`
  mode silently refuses reference media. In testing it also *under-moved*
  markedly on an identical prompt (valley motion 0.093 vs 0.400 for
  `seedance_2_0_mini`). It is for reference-driven and video-editing work.

```bash
higgsfield generate create seedance_2_0 \
  --prompt "$(cat prompt.txt)" \
  --start-image ./still.png \
  --duration 8 --resolution 720p --mode std --aspect_ratio 16:9 \
  --generate_audio false \
  --wait --wait-timeout 25m --json > out.json
```

**`--generate_audio` defaults to `true`.** Always disable it for background
loops: audio cannot ride a scroll-scrubbed or autoplaying video, and autoplay is
blocked outright with sound.

Result URL is `.[0].result_url` — *not* `.[0].results[0].url`. Renders take 3–8
minutes.

---

## 4. Prompting — what actually failed

### Never pin the end frame equal to the start frame

The first attempt (on ElevenCreative, ~$5) came back **completely static**. Two
identical endpoints over 5 seconds makes "change nothing" a valid solution, and
the cheapest one. Combined with a prompt full of prohibitions, stillness
satisfied every constraint.

**Leave `--end-image` empty and close the loop in post (§6).** The model's whole
budget should go into motion.

### Do not qualify the motion you are asking for

That same prompt asked for movement that was *"extremely slow," "weightless,"
"almost imperceptible."* It delivered imperceptible. Eight negative constraints
against three heavily-hedged positive ones is a prompt arguing against itself.

Ratio to aim for: **several strong positive motion statements, at most two lines
of constraint.**

### Anchor motion to places, not adjectives

"Embers rise from all across the landscape" produced embers pouring from a single
spot just left of centre — 6× more motion in one quarter than another. The model
put them where it thought the fire was, because nothing tied them to locations.

What worked was naming anchors and forcing the dead side explicitly:

> *"…from the ruined terraces at the far left edge, from the foreground ruins
> along the bottom centre, from the valley floor in the middle, and from the dark
> slopes at the far right edge. The right side of the frame has just as many
> embers as the left side."*

### Do not stabilise something into stillness

Trying to stop mist flooding the valley, the prompt said it *"stays the same
thickness throughout."* The mist then froze completely (valley motion 0.062). The
fix was to give it a **direction and a cycle** — *"rises upward, swells, and sinks
back down again"* — which moves without transforming.

### Prefer cyclical motion over one-way transformation

This is the single most useful idea in this document. **A particle system in
equilibrium loops by itself.** Embers that continuously spawn, rise and dissipate
never change state; only their distribution exists, and it looks identical at
every moment. Mist that *floods* a valley is a one-way transformation and cannot
loop — that produced a raw loop gap of 16.6, versus 1.5 for the equilibrium
version.

Say so explicitly: *"…so the air holds drifting embers at every moment, from the
very first frame to the very last. They never build up over time."*

### Lock the camera, and expect to repeat yourself

Every prompt said the camera was locked on a tripod. Terrain motion still ranged
from 0.257 to 0.700 across renders. It is worth stating, but not something to
rely on — measure it (§5).

### The prompt that shipped

`docs/CINEMATIC_ASSETS.md` holds the full text. Its shape:

1. Dominant motion, with locations and strong verbs
2. Secondary motion, described as a cycle
3. One line of camera lock + "the terrain is solid rock and stays perfectly still"
4. One line of mood
5. One line of exclusions (`no text, no logos, no people`)

---

## 5. The measurement harness

Do not judge these clips by eye. Frame-to-frame luminance delta separates the
motion you asked for from the motion you did not.

```bash
# Average motion inside a crop. Quadrant 0..3 left→right.
col() { ffmpeg -v error -i "$1" -vf \
  "crop=iw/4:ih:$2*iw/4:0,tblend=all_mode=difference,signalstats,\
metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null - 2>/dev/null \
  | grep -o "YAVG=[0-9.]*" | awk -F= '{s+=$2;c++} END{printf "%.3f", s/c}'; }

# Horizontal band. 0=sky 1=mid 2=ground.
row() { ffmpeg -v error -i "$1" -vf \
  "crop=iw:ih/3:0:$2*ih/3,tblend=all_mode=difference,signalstats,\
metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null - 2>/dev/null \
  | grep -o "YAVG=[0-9.]*" | awk -F= '{s+=$2;c++} END{printf "%.3f", s/c}'; }

# Loop gap: first frame vs last. Lower is easier to loop.
gap() { n=$(ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames \
  -of csv=p=0 "$1"); ffmpeg -v error -i "$1" -vf \
  "select='eq(n\,0)+eq(n\,$((n-1)))',tblend=all_mode=difference,signalstats,\
metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null - 2>/dev/null \
  | grep -o "YAVG=[0-9.]*" | tail -1 | cut -d= -f2; }
```

How to read the output:

- **Quadrants within ~2× of each other** ⇒ motion is distributed, not clustered.
- **Terrain crop near zero while the subject crop is high** ⇒ the camera is
  actually locked. If a static region moves as much as the moving one, the camera
  drifted regardless of what the prompt said.
- **Loop gap under ~4** ⇒ a crossfade can hide the seam. Above that, something is
  transforming rather than cycling; fix the prompt, not the encode.

Also render a first-vs-last **motion map** — flat means nothing moved there:

```bash
ffmpeg -y -i in.mp4 -vf "select='eq(n\,0)+eq(n\,LAST)',\
tblend=all_mode=difference,eq=contrast=11:brightness=0.06" -frames:v 1 map.png
```

A trap worth knowing: **a low loop gap can just mean stillness.** One render
scored an excellent 1.52 because almost nothing moved. Always read the gap
alongside the motion scores.

---

## 6. Encoding

### Do it in one pass

The single worst technical mistake of the session. Building the loop without
codec flags let ffmpeg silently re-encode at its default, and that file was then
encoded again to AV1:

| | bitrate |
| --- | --- |
| Higgsfield source | 1289 kbps |
| accidental intermediate | 534 kbps |
| shipped | **283 kbps** |

22% of the original, and visibly soft. Do trim, crossfade, crop, scale and final
encode in **one** ffmpeg invocation, straight from the downloaded file.

### Close the loop with a crossfade

Overlap the tail back onto the head. Works with any continuous motion, needs no
reversal, and costs a fraction of a second of duration:

```bash
S=source.mp4; TRIM=1.0; X=0.8      # drop the ramp-in, crossfade width
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $S)
MAIN=$(echo "$D - $TRIM - $X" | bc -l)

ffmpeg -y -ss $TRIM -i $S -filter_complex \
 "[0]trim=0:$MAIN,setpts=PTS-STARTPTS[main];\
  [0]trim=$MAIN,setpts=PTS-STARTPTS[tail];\
  [0]trim=0:$X,setpts=PTS-STARTPTS[head];\
  [tail][head]blend=all_expr='A*(1-(T/$X))+B*(T/$X)'[mix];\
  [main][mix]concat=n=2:v=1,fps=24" \
 -an -c:v libsvtav1 -crf 36 -preset 4 -g 48 -pix_fmt yuv420p \
 -movflags +faststart out.webm
```

Trimming the first second matters: a start frame containing none of the effect
means the clip always ramps in, and that ramp is what widens the loop gap.

**Ping-pong is the wrong tool.** It closes the seam better (1.67 vs 4.58) but
doubles the frames and plays any rising motion backwards — falling embers.

### Pick quality against a metric, not a feeling

Edge energy versus the source is a better guide than SSIM:

```bash
ffmpeg -v error -i clip.webm -vf "select='eq(n\,30)',sobel,signalstats,\
metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null -
```

| | edge | size |
| --- | --- | --- |
| source | 23.19 | — |
| AV1 crf 30 | 22.96 | 752 KB |
| **AV1 crf 36** | **22.83** | **576 KB** |
| AV1 crf 54 (double-encoded) | 22.00 | 244 KB |

**SSIM misled us.** It scored the over-compressed encode at 0.986 because it was
comparing against the already-degraded intermediate, not the source. Always
measure against the original download.

Also try 12fps: halving the frame count frees bits per frame, so `12fps crf 22`
matched 24fps crf 36 in size at slightly better per-frame quality. Slow
atmospheric motion does not need 24fps.

### Ship AV1 plus an H.264 fallback

```bash
# same filter_complex, different codec
-c:v libx264 -crf 26 -preset veryslow -g 48 -pix_fmt yuv420p -movflags +faststart
```

Serve via `<picture>`-style `<source>` ordering on the `<video>`. Extract the
poster from **the shipped encode's own first frame** so the still and the video
agree exactly.

---

## 7. Portrait variants

Two routes, and the cheap one usually wins:

**Crop the landscape clip — free.** A 0.58-aspect box shows ~32% of a 16:9
frame's width. Check where the motion lives first: cropping toward the busiest
region can *raise* the motion score (0.151 → 0.214 here). The cost is
composition — you lose whatever landmarks sit outside the window.

**Render natively at `--aspect_ratio 9:16` — 36 credits.** Better composition in
principle. In practice, the same prompt that behaved in 16:9 invented fires
across the terraces and drifted the camera, giving a loop gap of **6.20** against
1.63. We kept the crop.

If you do render portrait, use a natively-composed portrait still as the start
frame, and expect to re-verify everything — a new aspect ratio is a new
generation, not a reframing of the old one.

---

## 8. Credits ledger from this session

| Renders | Purpose | Credits |
| --- | --- | --- |
| 2 × `seedance_2_0_mini` | previz, two prompt variants | 25 |
| 1 × `seedance_2_5` | model comparison | 32.5 |
| 1 × `seedance_2_0` 8s | first equilibrium attempt (embers clustered) | 36 |
| 1 × `seedance_2_0` 8s | **shipped** | 36 |
| 1 × `seedance_2_0` 9:16 | portrait, rejected | 36 |
| | **total** | **~166** |

Two of six renders shipped anything. Budget for that ratio.

---

## 9. Checklist

Before rendering:

- [ ] `higgsfield workspace set` done
- [ ] cost checked with `generate cost`
- [ ] `--generate_audio false`
- [ ] `--end-image` **not** set
- [ ] motion described with strong verbs and named locations
- [ ] motion is cyclical, not a one-way transformation
- [ ] at most two lines of constraint
- [ ] duration longer than needed, so the ramp-in can be trimmed
- [ ] previz on `_mini` first if the prompt is unproven

After downloading:

- [ ] score quadrants, bands and loop gap (§5)
- [ ] check a static region to confirm the camera held
- [ ] encode in a **single pass** from the download
- [ ] compare edge energy against the **source**, not an intermediate
- [ ] poster extracted from the shipped encode
- [ ] record prompt, settings and credit cost alongside the asset
