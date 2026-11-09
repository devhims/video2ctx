# Overlays

`overlay` turns each rendered short into a HyperFrames project at `<project>/overlay/<id>/`. The footage is the base layer, with these on top:

- **Wordmark**: top right, for the whole short.
- **Hook**: the short's `hook` in the top slot for the first 3 s. A `|` splits it into lines, and the last line sits on the accent bar.
- **Name tag and context cards**: a dark card with a label-coloured rule. They never overlap each other: later ones wait their turn, and an item with no room before the end card is dropped with a warning.
- **Captions**: 1 to 3 words per group, with `emphasis` words in the accent colour.
- **End card**: `brand.endCard` lines for the last 2.4 s.

## Where things go

- **Headings** (hook, name tag, cards, end card) always sit at the top, starting 48 px below the wordmark.
- **Captions** never go at the top:
  - On `crop` and `fit` shots they sit low, between 1150 px and YouTube's bottom UI.
  - On `stack` shots they sit on the seam between the two people.

`overlay` finds the faces in each rendered short twice a second using macOS's Vision framework, with nothing to install, and saves them to `overlay/<id>/faces.json`. Off macOS, typical face areas for each framing stand in; check those snapshots closely. Faces decide only two things:

- **Where low captions sit:** as low as possible while clearing the chin, re-placed only at a camera cut or when a heading comes or goes.
- **When name tags and cards show:** they shift up to 2 s so they cover less face at the top.

Anything that still covers a face reports a percentage, such as "hook covers a face at the top: 24%". For each report, snapshot that moment and fix what the frame shows. Shorten the heading, time a name tag or card (`atSec`, `atPhrase`) to a moment when the head sits lower, or accept it when the overlap is only hair or a chin.

Context cards are optional. A small vertical frame often reads better with captions alone, so leave `cards` out unless a fact is essential to follow the clip.

Then render each one with the `render` command that `overlay` prints (`npx hyperframes@<version> render ...`). That writes `<project>/render/<id>-overlay.mp4`, at roughly 2 s of render time per second of video.

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
    "endCard": ["Full episode", "on The Inner Scorecard"]
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
        "cards": [
          {
            "label": "Context · Despicable Me",
            "title": "The Minions",
            "body": "Gru's yellow henchmen: loyal to a fault, and chaotically overeager.",
            "source": "Despicable Me (Illumination, 2010)",
            "atPhrase": "like the minions"
          }
        ]
      }
    }
  ]
}
```

- `wordmark`: when there are three or more lines, the first is set small (as in "the").
- `nameTag` and `cards`: time them with `atPhrase` (the first matching caption words) or `atSec` (seconds into the short). A name tag with neither follows the hook.
- `hookImage` (`{ "src": "images/person.jpg", "alt": "Name" }`): a round photo beside the hook, for when the hook names someone viewers may not recognise. `src` is a local file, relative to the project. Use only images whose license allows it, such as Wikimedia Commons or the person's official press kit. Ask before downloading one, crop it around the face, and put the credit the license requires in the description.
- `emphasis`: 3 to 10 words per short, the ones carrying the meaning. A word coloured everywhere stops meaning anything.
- Fonts are HyperFrames' bundled Montserrat (hook, end card), Oswald (wordmark, card titles), Poppins (captions) and Inter (card text). To use the channel's own fonts, add `@font-face` rules and the font files to the generated project.

## Check before delivering

Snapshot each project at the hook, the name tag, each card, a `stack` shot and the end card (`npx hyperframes snapshot --at <seconds,...> --no-end` inside `overlay/<id>`), and look at every frame:

- Headings sit at the top below the wordmark, captions sit low or on the seam, nothing covers eyes or mouths, and every face report is fixed or accepted after looking.
- No text sits under the platform's right-hand buttons or below about 1330 px.
- Cards don't cover a face.
- Each keyword lands on the right word.

Burned-in logos in the source footage can double up with the wordmark on `stack` shots. Note it in the brief.
