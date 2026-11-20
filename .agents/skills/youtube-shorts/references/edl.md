# edl.json

The edit decision list lives at `<project>/edl.json`. You write the phrases, hooks, glossary, and layout; `plan` fills in times, caption text, and durations.

```json
{
  "videoId": "dD1zZE15irQ",
  "glossary": { "such office": "Satya's office", "Guru": "Gru" },
  "leadInMs": 120,
  "shorts": [
    {
      "id": "S1",
      "title": "AI agents are Minions",
      "hook": "AI agents are like the Minions.",
      "cuts": [
        { "from": "what if the AI is just very eager", "to": "but come on", "after": "11:00" }
      ],
      "layout": [
        { "atMs": 684760, "mode": "crop", "x": 0.47 }
      ]
    }
  ]
}
```

## Cuts

- `from` and `to` are phrases quoted from `transcript.md`. Re-quote them if the project's transcript changes, for example from YouTube captions to Whisper. Matching ignores case, punctuation, `>>`, and sound tags such as `[music]`. `to` is searched after `from`.
- `after` (`m:ss` or `h:mm:ss`) pins the first match of `from` at or after that time. `plan` warns when an unpinned `from` occurs more than once.
- Phrases win over stored times: `plan` overwrites `startMs`/`endMs` on every run. To pin times by hand, delete `from`/`to` and give integer `startMs`/`endMs`.
- `endMs` is where the next word begins (capped at 1 s after the last word starts), so the last word plays in full.
- `leadInMs` (default 120) starts the media slightly early because caption timings run late. It never reaches back past 200 ms after the previous word's start.
- Cuts play in array order and may come from anywhere in the video.
- `id` uses letters, digits, `-`, and `_`; it names the output files.

## Layout

Each entry applies from `atMs` (source time) until the next entry. Use the `atMs` values from `shots` so each camera shot gets its own entry, sorted by `atMs`.

| Mode | Use for | Options |
|---|---|---|
| `crop` | One person or subject in frame | `x`: horizontal center of the 9:16 window, as a fraction of frame width (0 left, 1 right). Put it on the speaker's face. |
| `stack` | Side-by-side split screens, where each half holds a person | `y`: vertical center of each half's crop (default 0.45). `swap: true` puts the right half on top. |
| `fit` | Slides, screens, wide shots, or anything that must stay whole | None. The full frame sits over a blurred fill. |

Estimate `x` from the sheet: a face centered at 40% of the tile's width gets `x: 0.4`. `stack` assumes the halves split at the frame's center line.

## Outputs

`render` writes to `<project>/render/`:

- `<id>.mp4`: 1080x1920, loudness-normalized to about -14 LUFS, no captions.
- `<id>.srt`: plain captions on the short's timeline, glossary applied, fillers removed.
- `<id>.ass`: styled captions (bold uppercase in the lower third) plus the hook at the top for the first 3 seconds.
- `<id>-captioned.mp4`: the `.ass` burned in. FFmpeg can only do this when it was built with libass (it has the `subtitles` filter); otherwise `render` warns and skips it.
- `<id>-preview.jpg`: three frames at 10%, 50%, and 90%.

`shots` writes `<project>/shots/<id>.jpg` (the contact sheet) and `<project>/shots/<id>/NN.jpg` (one thumbnail per shot, from the middle of the shot).
