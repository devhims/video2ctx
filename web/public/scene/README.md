# Fold background scene

A locked-camera voxel landscape with five carved video-tool symbols, looping
behind the landing fold. Source material lives in `brand/`, not here — this
directory holds only what is served.

## What ships

| File | Serves |
| --- | --- |
| `fold-scene-symbols.webm` / `.mp4` | the loop, on pointer desktops |
| `fold-scene-symbols-poster.webp` | first paint, and the resting still under the flashlight |
| `voxel-horizon-symbols.webp` | 1672 × 941, the `<img>` fallback |
| `voxel-horizon-symbols-900.webp` | narrow landscape, e.g. a rotated phone |
| `fold-scene-portrait.webm` / `.mp4` / `-poster.webp` | the portrait loop, a crop of the landscape one |
| `voxel-icon-glow-mask.webp` | the flashlight's symbol glow, see below |

`<picture>` resolves exactly one still per visitor, and `<source>` order means
each visitor fetches exactly one video. The totals above are repo size, not page
weight. AV1 is served first; the H.264 sibling exists because Safari's AV1
support is hardware-gated to M3 / A17 Pro and newer, so every Intel Mac, M1, M2
and pre-15-Pro iPhone falls through to it.

Both mp4s are crf 24, not a sharper number. Edge energy at crf 24 matches the
AV1 the majority actually receive (23.73 against 23.72); the previous crf 21 was
*sharper than the primary asset* at 24.28, spending 636 KB to over-encode a
fallback.

### The portrait loop

Not its own render. Re-crop it whenever the landscape loop changes, or portrait
silently keeps showing the previous scene:

```bash
ffmpeg -y -i fold-scene-symbols.webm -vf "crop=416:720:240:0,scale=440:762" -an \
  -c:v libsvtav1 -crf 36 -preset 4 -g 48 -pix_fmt yuv420p fold-scene-portrait.webm
ffmpeg -y -i fold-scene-symbols.webm -vf "crop=416:720:240:0,scale=440:762" -an \
  -c:v libx264 -crf 24 -preset veryslow -g 48 -pix_fmt yuv420p fold-scene-portrait.mp4
```

The `x=240` offset is chosen, not incidental. It trades symbol coverage for copy
legibility: further left holds more carvings but pushes brighter terrain up
behind the headline. It keeps the timeline and speaker whole and clips the play
panel at the frame edge. Earlier it sat at `x=432`, which caught only the
speaker and gave phones the emptiest part of the scene.

Portrait phones get `fold-scene-portrait-poster.webp` as their resting still —
literally the loop's own frame 0, so still and clip cannot disagree. There used
to be separate 3:4 artwork here (`voxel-horizon-portrait.webp`, now in
`brand/source/`), and it went stale the moment the symbols landed: phones saw a
symbol-less still behind a loop that had them.

Everything here is served. Superseded renders and the stills the mask is derived
from live in `brand/generated/` and `brand/source/`.

## How the current loop was made

1. **The symbols** were carved into the scene still with the built-in GPT Image
   editor, producing `brand/source/voxel-horizon-video-icons-gpt.webp`. It is a
   surgical edit of `voxel-horizon.webp`: 1.85% of pixels change, all of them at
   the five symbol sites, so terrain, palette and exposure are untouched.
2. **The video edit** took the previous loop plus that still as a reference.
   Prompt, settings and the measured result: `brand/prompts/voxel-horizon-symbols-videoedit.txt`.
   **The raw render is not kept in the repo** — only the graded loop below. To
   change the grade, the trim, the crossfade or the codec you need that raw file
   back, which means re-running the video edit.
3. **Grade, loop and encode**, one pass straight from the raw download. The
   render came back with lifted blacks, lost saturation and an audio track:

```bash
SRC=<the raw video-edit render, see step 2>
GRADE="lutyuv=y='clip(val-6*max(0\,1-val/25)\,0\,255)',eq=saturation=1.12"
FC="[0]${GRADE},setpts=PTS-STARTPTS,split=3[m][t][h];\
[m]trim=0:6.2,setpts=PTS-STARTPTS[main];\
[t]trim=6.2,setpts=PTS-STARTPTS[tail];\
[h]trim=0:0.8,setpts=PTS-STARTPTS[head];\
[tail][head]blend=all_expr='A*(1-(T/0.8))+B*(T/0.8)'[mix];\
[main][mix]concat=n=2:v=1,fps=24"

ffmpeg -y -ss 1.0 -i "$SRC" -filter_complex "$FC" -an \
  -c:v libsvtav1 -crf 36 -preset 4 -g 48 -pix_fmt yuv420p -movflags +faststart \
  fold-scene-symbols.webm
ffmpeg -y -ss 1.0 -i "$SRC" -filter_complex "$FC" -an \
  -c:v libx264 -crf 24 -preset veryslow -g 48 -pix_fmt yuv420p -movflags +faststart \
  fold-scene-symbols.mp4
ffmpeg -y -i fold-scene-symbols.webm -frames:v 1 /tmp/p.png \
  && cwebp -quiet -q 86 -m 6 /tmp/p.png -o fold-scene-symbols-poster.webp
```

The grade is YUV-native on purpose. `curves` and `colorlevels` are RGB filters,
and the round trip retags the stream as limited range, clamping blacks to 16 —
the opposite of the correction being applied. The taper means the shadow pull
reaches zero by luma 25, so midtones keep their level and low-contrast fog
detail survives.

Trim, crossfade and encode belong in **one** ffmpeg invocation. An accidental
intermediate re-encode once cost 60% of the bitrate before the browser saw it.

Stills are re-encoded from the GPT source at the same quality as before. 82
rather than the visually identical 72 is deliberate: the scene is mostly
near-black, and dark gradients are where webp banding shows first.

```bash
dwebp brand/source/voxel-horizon-video-icons-gpt.webp -o /tmp/src.png
cwebp -quiet -q 82 -m 6 /tmp/src.png -o voxel-horizon-symbols.webp
cwebp -quiet -q 78 -m 6 -resize 900 0 /tmp/src.png -o voxel-horizon-symbols-900.webp
```

## The symbol glow mask

`voxel-icon-glow-mask.webp` is the alpha the flashlight uses to warm the
symbols. It is **derived, not drawn** — the difference between the still with
symbols and the one without, high-passed to keep the carved edges:

```bash
# 1. the difference between the two stills IS the symbol layer.
#    Both inputs live in brand/source/ — neither is served, and neither is
#    optional. Run from the repo root.
ffmpeg -y -i brand/source/voxel-horizon.webp \
       -i brand/source/voxel-horizon-video-icons-gpt.webp \
  -filter_complex "[0][1]blend=all_mode=difference,format=gray" -frames:v 1 /tmp/raw.png

# 2. drop the noise floor FIRST. Both stills are webp, and their compression
#    noise is a few counts everywhere; step 3 multiplies by 6, which turns that
#    into a field of speckle across the whole frame.
ffmpeg -y -i /tmp/raw.png -vf "lut=y='if(gt(val,14),val,0)'" -frames:v 1 /tmp/floor.png

# 3. high-pass to keep the carved edges and discard the broad panel lift
ffmpeg -y -i /tmp/floor.png -filter_complex \
  "[0]split[a][b];[b]gblur=sigma=7[lo];[a][lo]blend=all_mode=difference,format=gray,\
   lut=y='min(255,val*6)',gblur=sigma=1.1,\
   curves=all='0/0 0.10/0.10 0.30/0.62 0.55/0.95 1/1'" -frames:v 1 /tmp/dog.png

# 4. region gate, in two halves. A single global gate cannot work here — see
#    the note below. Strict gate for the cluttered lit terrain:
ffmpeg -y -i /tmp/raw.png -vf \
  "lut=y='if(gt(val,14),255,0)',gblur=sigma=16,lut=y='if(gt(val,18),255,0)',\
   dilation,dilation,gblur=sigma=5" -frames:v 1 /tmp/gate_tight.png

# 5. permissive gate, admitted only where the stone is dark and therefore has
#    no terrain-edge clutter to reject
ffmpeg -y -i brand/source/voxel-horizon-video-icons-gpt.webp -vf \
  "format=gray,gblur=sigma=30,lut=y='clip((75-val)*8.5,0,255)',gblur=sigma=8" \
  -frames:v 1 /tmp/dark.png
ffmpeg -y -i /tmp/raw.png -vf \
  "lut=y='if(gt(val,10),255,0)',gblur=sigma=14,lut=y='if(gt(val,8),255,0)',\
   dilation,dilation,dilation,gblur=sigma=5" -frames:v 1 /tmp/gate_loose.png
ffmpeg -y -i /tmp/gate_loose.png -i /tmp/dark.png \
  -filter_complex "[0][1]blend=all_mode=multiply,format=gray" -frames:v 1 /tmp/loose_dark.png
ffmpeg -y -i /tmp/gate_tight.png -i /tmp/loose_dark.png \
  -filter_complex "[0][1]blend=all_mode=lighten,format=gray" -frames:v 1 /tmp/gate.png

# 6. combine, then white-with-alpha at the video's native size
ffmpeg -y -i /tmp/dog.png -i /tmp/gate.png \
  -filter_complex "[0][1]blend=all_mode=multiply,format=gray" -frames:v 1 /tmp/mask.png
ffmpeg -y -i /tmp/mask.png -filter_complex \
  "[0]scale=1280:720,format=gray[m];color=c=white:s=1280x720[w];[w][m]alphamerge,format=rgba" \
  -frames:v 1 /tmp/final.png
cwebp -quiet -q 88 -alpha_q 100 -m 6 /tmp/final.png -o voxel-icon-glow-mask.webp
```

### Why the gate is split

A single global gate cannot serve this frame, and trying costs the crop-frame.

The speckle is on the **lit left**, where terrain edges are dense and the diff's
webp noise has plenty of structure to latch onto. The crop-frame is on the
**dark right**: four thin strokes with wide gaps, low local density, nothing
around it. Any gate strict enough to reject the first also rejects the second.

Measured on the shipped 1280 × 720 masks, mean alpha inside each symbol's box,
and the fraction of the frame above alpha 8:

| gate | play | timeline | speaker | crop | wave | spread |
| --- | --- | --- | --- | --- | --- | --- |
| loose everywhere | 43.7 | 51.2 | 28.5 | 11.9 | 20.0 | 2.32% |
| strict everywhere | 47.6 | 59.4 | 30.9 | **9.9** | 19.7 | 2.00% |
| split (shipped) | 47.8 | 59.6 | 31.8 | **14.3** | 21.2 | 2.14% |

Strict-everywhere looks like the right answer on the aggregate and is not: the
crop-frame stops reading on screen at 9.9. Density-based variants were worse
still, one dropped it to 0.7 and two zeroed it. The crop-frame is the canary
here; it is the weakest of the five by a wide margin and it fails first.

When regenerating, check all five boxes individually. Spread near 2.3% means the
noise floor in step 2 was skipped; a crop-frame under about 12 means the gate is
too strict regardless of how clean the footprint looks.

Two things this depends on, both silent if broken:

- **`brand/source/voxel-horizon.webp` must stay.** It is the pre-symbol scene
  still, the "before" half of the diff. Nothing serves it and nothing imports
  it, so it looks like dead weight in a cleanup pass. Delete it and this mask
  can never be regenerated from source.
- **The mask shares the video's aspect ratio**, so `mask-size: cover` resolves to
  the same box the video does. Replace the footage at a different aspect and the
  symbols misregister with no error.

Re-render the scene and this must be regenerated from the same pair of stills.

## Known state

Fog motion in the current loop measures 0.177 against the previous loop's 0.240.
That is the render, not the encode — crf 30 only recovers to 0.194 for an extra
231 KB. The valley is calmer than it used to be.

## Compositing

Dimming, the fade mask, parallax, the flashlight and the symbol glow all live in
`web/app/craft.css`, so the look can be retuned without regenerating anything.
The pointer loop is in `web/app/_directions/flashlight.tsx`.

Method and prompting guidance for new renders:
`reference/design/HIGGSFIELD_ASSET_GUIDE.md`.
