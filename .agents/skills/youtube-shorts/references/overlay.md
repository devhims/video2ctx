# Overlays

`overlay` turns each rendered short into a HyperFrames project at `<project>/overlay/<id>/`. The footage is the base layer, with these on top:

- **Wordmark**: top right, for the whole short.
- **Hook**: the short's `hook` in the top slot for the first 3 s. A `|` splits it into lines, and the last line sits on the accent bar.
- **Name tag and context cards**: a dark card with a label-coloured rule. They never overlap each other: later ones wait their turn, and an item with no room before the short ends is dropped with a warning.
- **Captions**: 1 to 3 words per group, with `emphasis` words in the accent colour.
- **Zooms and scenes**: camera moves on key lines, and hand-made animations in the bottom half or over the whole frame. See [motion.md](motion.md) before adding either.
- **End card**: 2.8 s after the last word. The final frame freezes and blurs, the source video's thumbnail lands with a riser and a hit, a tap presses its play button, and a chip points at the related-video link below the Short. The publish skill sets that link to the episode.

`overlay` fetches the thumbnail from YouTube and takes sound effects from HyperFrames' bundled library (offline, no account), caching them in `<project>/overlay/.sfx`. When either is unavailable it warns and carries on: a text-only end card, silent cues.

## Where things go

- **Headings** (hook, name tag, cards) always sit at the top, starting 48 px below the wordmark.
- **Captions** never go at the top:
  - On `crop` and `fit` shots they sit low, between 1150 px and YouTube's bottom UI.
  - On `stack` shots, and under a bottom-half scene, they sit on the seam at mid-frame.
  - Under a full-frame scene they sit low.

`overlay` finds the faces in each rendered short twice a second using macOS's Vision framework, with nothing to install, and saves them to `overlay/<id>/faces.json`. Off macOS, typical face areas for each framing stand in; check those snapshots closely. Faces decide three things:

- **Where low captions sit:** as low as possible while clearing the chin, re-placed only at a camera cut or when a heading or scene comes or goes.
- **When name tags and cards show:** they shift up to 2 s so they cover less face at the top.
- **Where zooms centre:** on the speaker's face at that moment.

Anything that still covers a face reports a percentage, such as "hook covers a face at the top: 24%". For each report, snapshot that moment and fix what the frame shows. Shorten the heading, time a name tag or card (`atSec`, `atPhrase`) to a moment when the head sits lower, or accept it when the overlap is only hair or a chin.

Text cards clutter a vertical frame. Leave `cards` out and carry the moment with a zoom or a scene instead. Keep a card only for a sourced fact the clip cannot be followed without.

Then render each one with the `render` command that `overlay` prints (`npx hyperframes@<version> render ...`). That writes `<project>/render/<id>-overlay.mp4`, at roughly 2 s of render time per second of video. HyperFrames encodes with the first FFmpeg on `PATH`, which needs libx264. If the render fails with "Unrecognized option 'preset'", put a full FFmpeg build first on `PATH` for that command.

## Take the look from the channel

Match what the channel already publishes before choosing anything. This research uses the youtube-ctx skill; install it with `npx skills add devhims/video2ctx --skill youtube-ctx` if it is missing.

1. List the channel's uploads with youtube-ctx (`channel-videos`) and view the thumbnails of recent episodes and clips (`https://i.ytimg.com/vi/<id>/hqdefault.jpg`). Note the type (weight, case), the accent colour and how it is used (bars behind words, keyword colour), and the wordmark.
2. Take a storyboard of one of the channel's clips and one teaser, then exact frames of any cards or kinetic captions you spot. These show the in-video patterns: lower thirds, context cards, caption fonts.
3. Write what you found into `brand`, and say in the brief which video each choice came from.

Use the channel's own words and colours. Cards state only facts you can source: put the source on the card, or leave the card out.

## edl.json fields

```json
{
  "brand": {
    "wordmark": ["the", "INNER", "SCORECARD"],
    "wordmarkTag": "CLIPS",
    "accent": "#E3262E",
    "label": "#F5A623",
    "endCard": { "channel": "on The Inner Scorecard" }
  },
  "speakers": {
    "guest": { "name": "Joaquin Quiñonero Candela", "role": "Former OpenAI, Meta & Microsoft", "label": "Guest" }
  },
  "shorts": [
    {
      "id": "S1",
      "hook": "AI agents are | like the Minions",
      "overlay": {
        "nameTag": { "speaker": "guest" },
        "emphasis": ["minions", "cake", "house", "car"],
        "zooms": [
          { "atPhrase": "to be mischievous" },
          { "atPhrase": "what the hell", "kind": "punch" }
        ],
        "scenes": [
          { "src": "scenes/s1-network.html", "mode": "bottom", "atSec": 16.52, "expandAtSec": 20.75, "endPhrase": "I mean, the minions love" }
        ]
      }
    }
  ]
}
```

- `wordmark`: when there are three or more lines, the first is set small (as in "the").
- `endCard`: present to add the end card. `heading` (default `["Watch the", "Full episode"]`, last line on the accent bar), `channel` (the line under the thumbnail), and `cta` (default "Tap the link below"; `""` hides it). Omit `endCard` for no end card.
- `nameTag` and `cards`: time them with `atPhrase` (the first matching caption words) or `atSec` (seconds into the short). A name tag with neither follows the hook.
- `hookImage` (`{ "src": "images/person.jpg", "alt": "Name" }`): a round photo beside the hook, for when the hook names someone viewers may not recognise. `src` is a local file, relative to the project. Use only images whose license allows it, such as Wikimedia Commons or the person's official press kit. Ask before downloading one, crop it around the face, and put the credit the license requires in the description.
- `emphasis`: 3 to 10 words per short, the ones carrying the meaning. A word coloured everywhere stops meaning anything.
- `zooms` and `scenes`: see [motion.md](motion.md).
- Fonts are HyperFrames' bundled Montserrat (hook, end card), Oswald (wordmark, card titles), Poppins (captions) and Inter (card text). To use the channel's own fonts, add `@font-face` rules and the font files to the generated project.

## Check before delivering

Snapshot each project at the hook, the name tag, each card, a `stack` shot, each zoom and scene (see [motion.md](motion.md)), and the end card at 0.4 s, 1 s and 2.7 s past the last word (`npx hyperframes snapshot --at <seconds,...> --no-end` inside `overlay/<id>`). Look at every frame:

- Headings sit at the top below the wordmark, captions sit low or on the seam, nothing covers eyes or mouths, and every face report is fixed or accepted after looking.
- No text sits under the platform's right-hand buttons or below about 1330 px.
- Cards don't cover a face.
- Each keyword lands on the right word.
- The end card shows the right thumbnail, the tap lands on the play button, and nothing of the speech is cut off.

Burned-in logos in the source footage can double up with the wordmark on `stack` shots. Note it in the brief.
