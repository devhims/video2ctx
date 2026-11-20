# Zooms and scenes

Motion carries a moment better than text on a vertical frame. Two tools, both in a short's `overlay`:

- **Zooms**: camera moves on the speaker when they say something that lands.
- **Scenes**: hand-made animations that act the idea out, in the bottom half or over the whole frame, then hand back to the speaker.

Plan both from the cut's `text`: mark the punchlines (zoom candidates) and the ideas a picture explains (scene candidates). Most shorts need two or three zooms and at most one or two scenes.

## Zooms

```json
"zooms": [
  { "atPhrase": "to be mischievous" },
  { "atPhrase": "biggest cake in the world", "kind": "push" },
  { "atPhrase": "what the hell", "kind": "punch" }
]
```

| `kind` | Move | Sound |
|---|---|---|
| `snap` (default) | 1.16x in 0.14 s, held 1.2 s | none (`"sound": true` adds a whoosh) |
| `push` | 1.15x over 1 s, held 0.6 s | none |
| `punch` | 1.22x in 0.12 s, held 0.9 s | bass hit (`"sound": false` drops it) |

`scale` and `holdSec` override the defaults. Each zoom centres on the speaker's face and eases back over 0.4 s; one that runs into a full-frame scene resets under it instead.

Zooms are seasoning: about one every 10 s, each on a punchline. `overlay` reports zooms closer than 6 s, and skips any that land on a split screen (it would crop both people), under a scene, or before the previous zoom has eased back. A zoom never holds across a camera cut: `overlay` eases it back before the cut, or skips it when there is no room.

## Scenes

A scene is a HyperFrames sub-composition file you write, in the project (such as `scenes/s1-network.html`). `overlay` copies it into `overlay/<id>/compositions/` and mounts it, so rerunning `overlay` keeps it.

```json
"scenes": [
  { "src": "scenes/s1-network.html", "mode": "bottom", "atSec": 16.52, "expandAtSec": 20.75, "endPhrase": "I mean, the minions love" },
  { "src": "scenes/s1-cake.html", "mode": "full", "atSec": 29.93, "endPhrase": "So cake, if Gru" }
]
```

- **`mode: "bottom"`** slides the scene up over the lower half while the speaker stays in view above it, with captions on the seam. Use it when the speaker's face matters, and on split screens, where it covers the listener.
- **`mode: "full"`** opens the scene over the whole frame with an iris and closes it the same way. Use it when the idea needs the whole frame.
- **`expandAtPhrase` / `expandAtSec`** grows a bottom scene to the whole frame partway through. Time it to a camera cut so the cut happens unseen.
- Start with `atPhrase` or `atSec`; end with `endPhrase` (the scene closes as it starts) or `durationSec`. `overlay` adds the slide, iris and wipe transitions, with a whoosh only as the scene opens (`"enterSound": false` drops it, `"exitSound": true` adds one as it closes).
- On a split screen, let the host be seen: start a bottom scene about 2 s after the cut to the split, so the podcaster gets screen time before the scene covers their half. A scene starting exactly on the cut appears with it instead of sliding in. `overlay` reports one that starts just after the cut, where the host would only flash up.

### What a scene shows

Illustrate the idea as a small diagram that moves on the speaker's words: agents as nodes that pop in, lines that draw between them as they "collaborate", a sudden colour change on the punchline (every node turning yellow on "minions"), a chain of icon nodes that builds item by item, each lit on its word. Keep text out of scenes: icons, shapes, colour and motion carry it, and the captions carry the words. Never squeeze an animation into a corner beside the face: if it needs room, it gets the bottom half or the whole frame.

### Designing the picture

A viewer gets one glance with the sound off. Each scene must survive that.

- **One idea, one concrete picture.** Pick an object that already means the thing being said: a bar of time losing pieces, a project timeline with stages, a scale tipping, a chart flattening. Use nodes and links only when the idea is a network (agents collaborating); elsewhere a hub-and-spoke just says "network". Avoid shapes with an unintended meaning: wedges around a dot read as a hazard sign, a square in a circle as a stop button.
- **A visible change, timed to the words.** Start from a clear first state and change it on the words that carry the point (a piece greys out on each request, a marker fills as each person joins). Hold the final state long enough to read.
- **Few elements.** Five to eight shapes, one icon style, aligned on a simple grid or circle, evenly spaced, nothing touching or overlapping.
- **No divider.** A bottom scene meets the footage directly: no line, bar or border between them.
- **Centred, and filling its area.** A bottom scene's area is the lower half below the seam captions (y 1010 to about 1440); a full scene's runs from below the wordmark to above the low captions (about 260 to 1400). Measure the drawn extents from snapshots (the first state, the middle and the final state), then shift the drawing to the centre of its area and scale it to about 900 px wide or the area's height, whichever comes first. Don't centre by eye in the code. Strokes stay at least 6 px at 1080 wide.
- **Neutral palette.** A scene sits under the footage: a warm off-white for the main shapes, greys for secondary or "not this" parts, a charcoal background, and one highlight colour for the element that matters. The highlight can come from the idea (Minion yellow), but never the channel's accent colour or another saturated red; that colour belongs to the hook and caption keywords.
- **Connectors end at outlines.** Draw lines behind shapes and stop them a few pixels short of each shape's edge: a person's head or shoulders, a card's border, a node's ring. A line aimed at a shape's centre lands, on a person icon, in the gap between head and body.
- **Things that belong together share one anchor.** A laptop in front of a person, a marker under a figure: position both from the same coordinate, never two hand-typed numbers that can drift apart. Clip moving parts (a scrolling ruler, a flowing row) to the shape they belong to, so no stray piece shows past its end.
- **Centre glyphs on their outline.** An icon inside a container (a heart in a circle) is centred on its measured bounds, not its path's origin.
- **Review at phone size.** Snapshot the first state, each change and the final state, and look at them about 3 inches tall. If the idea isn't obvious without the caption, redesign rather than adjust.

### Writing a scene file

Follow the HyperFrames scene format (`npx hyperframes docs compositions`). The parts that matter here:

- Everything sits inside `<template>`. The root element is `<div id="root" data-composition-id="<id>" data-width="1080" data-height="1920">`, styled as `#root { position: absolute; inset: 0; ... }` with its own background. The timeline registers as `window.__timelines["<id>"]` with the same id. `overlay` reads the id from the file.
- Times are local: 0 is the scene's start. Take each word's time from the short's captions (`render/<id>.srt`) and subtract the scene's start.
- Use `fromTo`, never `from`, since the host re-seeks the scene each time it shows. Add `immediateRender: false` to a `fromTo` that starts later and sets a visible start state.
- Build anything that scales or bounces as HTML elements (absolutely positioned `div`s), and use SVG only for lines and icons inside them. GSAP measures SVG boxes for `transformOrigin` when the timeline is built, before the scene is laid out, so scaled SVG groups pivot from the wrong point and drift off their lines.
- When an SVG shape must animate anyway, animate an unpositioned wrapper group around it. GSAP takes over an SVG element's whole `transform` when it tweens `scale`, `x` or `y`: a pop-in resets the shape's own scale, and an absolute `y` sends it to the top of the frame. Keep the shape's position and size on an inner group, or tween with relative values such as `'+=40'`.
- Draw lines with `stroke-dasharray` equal to the line's length and tween `stroke-dashoffset` to 0. Use `stroke-linecap="butt"`, since round caps show as dots before the line draws.
- For a bottom scene, draw in the lower half (y 1010 to about 1440) and keep the upper half empty: it is masked off until an expand.
- Sounds: `<audio class="clip" src="assets/sfx/<key>.mp3" data-start="..." data-volume="0.5">` with a local `data-start`. `overlay` fetches every key a scene names from the bundled library (`pop`, `click`, `click-soft`, `sparkle`, `whoosh`, `whoosh-short`, `impact-bass-1`, `riser`, `notification`, `error` and more). Land each sound's peak one frame after its picture: `pop` peaks 0.12 s into the file, `click` and `click-soft` 0.073 s, `error` 0.745 s, `impact-bass-1` 0.073 s, `whoosh` 0.162 s. At 0.2 to 0.6 volume. `hyperframes check` warns that nested audio times may be ambiguous; local times are what scenes use.

## Check

Snapshot each zoom at its peak, and each scene at its first beat, its middle, any expand, and 0.2 s before it ends. Look at every frame:

- Zoomed frames keep the eyes and mouth in view.
- Nodes sit on their lines, nothing stray shows before it animates in, and the scene's bottom half (or whole frame) is fully covered with no footage peeking at the corners.
- Captions sit on the seam under a bottom scene, and low under a full one.
- The scene meets the footage with no divider, sits centred in its area and fills it, keeps to the neutral palette, and passes the phone-size read in "Designing the picture". Connectors stop at outlines.

## Sound

Less is more. A sound goes only where it has impact: the beat a scene turns on (the word "paranoid" as the wave spreads, the thud of a red X), a punch-in, the first entrance of an animation. Node pops, drawn lines, colour changes and exits stay silent; their motion is enough. A 25 to 45 s short carries about four to six sounds besides the end card, spread through it.

Then render and listen to the whole short once: each sound lands on its picture, sits under the voice, and earns its place.
