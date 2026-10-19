# Visual context workflow

Use the bundled executable for a progressive visual read. For requested frames, locate candidate timestamps in the timed transcript first. Use storyboards only when captions are missing, ambiguous, or insufficient to locate the requested visual. Indexing does not require FFmpeg; exact-frame extraction does.

## Locate requested frames from the timed transcript

Resolve `scripts/watch.mjs` relative to the parent skill directory containing `SKILL.md`, then extract the 11-character video ID from the supplied YouTube URL.

```bash
node <skill-directory>/scripts/watch.mjs index --video-id 4vItmdk8F_M
```

Parse the JSON response and read `transcript.segments`. Use the requested topic, announcement, or spoken cue to find the relevant interval and choose candidate timestamps within it. Indexing creates the workspace needed for frame extraction without fetching storyboards by default. Use `--granularity word` only when word-level timing materially changes the task. `--transcript-only` remains a compatibility alias for the default.

For example, if a model announcement starts at 19:40 and its capability and cost discussion follows over the next 40 seconds, extract candidate frames in that interval. Inspect the frames to confirm the requested subject is visible; spoken cues do not establish which slide or camera view is on screen. Adjust nearby timestamps if needed. When the transcript locates the subject and the extracted frames satisfy the request, finish without storyboards.

If captions are unavailable or do not locate the requested visual, continue with the storyboard scan below. Requests about scene structure, silent demonstrations, or visual transitions also use this scan when spoken cues are insufficient.

## Use storyboards when the transcript is insufficient

Add `--with-storyboards` to fetch the transcript and storyboard contact sheets:

```bash
node <skill-directory>/scripts/watch.mjs index --video-id 4vItmdk8F_M --with-storyboards
```

This creates a new workspace. Keep track of both workspaces if the transcript-only index succeeded, and clean each one after use. Parse the response and explicitly open every path in `storyboard.sheets` with the available image-viewing tool. Each sheet is a contact sheet. Calculate a tile timestamp with:

```text
(firstFrameIndex + row * columns + column) * intervalMs
```

This formula returns an integer `timestampMs`. Keep storyboard-derived timestamps in milliseconds. When `video.durationSeconds` is available, require each value to be less than `video.durationSeconds * 1000`.

After reading the index, answer directly when it provides enough evidence for the requested claims. Storyboards are suited to video structure, scene or slide sequences, locating demonstrations, and rough visual changes.

## Verify with exact frames when needed

Extract exact frames when the answer depends on small text, code, chart values, detailed interface state, a brief visual change, a precise comparison, an ambiguous storyboard tile, or a frame the user explicitly requested. Storyboard tiles are sampled and low resolution, so do not use them alone for details they cannot resolve.

Choose no more than 30 timestamps that answer the user's question. Prefer a small, diverse set over adjacent or repetitive moments.

```bash
node <skill-directory>/scripts/watch.mjs frames \
  --workspace <workspace-from-index> \
  --timestamps-ms 1000,4500,11000
```

Use `--timestamps-ms` for transcript `startMs`/`endMs` values and timestamps calculated from the storyboard index. Use `--timestamps` only for timestamps expressed in seconds, including decimals such as `1,4.5,11`. Never pass millisecond values to `--timestamps`.

If validation identifies an out-of-range timestamp, check the selected flag and its unit before editing the list. Do not guess which value failed or retry by dropping values speculatively.

Explicitly open every returned `frames[].path` with the image-viewing tool. Keep each image associated with `timestampMs`; a file path alone is not visual context. Reflect `failures` and `meta.warnings` when the answer depends on missing or low-resolution evidence.

If exact frames fail with `DEPENDENCY_MISSING`, continue with a qualified index-only answer when the available evidence supports one. Report that FFmpeg must be installed or supplied with `--ffmpeg-path` when the unresolved question requires exact frames. Do not install system software without user authorization.

## Clean up

After the images have been consumed and the answer is complete, remove only the marked workspace returned by the index operation:

```bash
node <skill-directory>/scripts/watch.mjs cleanup --workspace <workspace-from-index>
```

The cleanup command rejects arbitrary directories. Preserve the workspace until no further image reads are needed. When delivering extracted images, copy the selected files to a persistent output location before cleanup and use those paths in the answer.

## Completion criteria

For requested frames, completion requires transcript-based timestamp selection first, or a recorded reason captions were insufficient; every returned frame must be explicitly loaded and checked against the request. Storyboards need to be read only when that fallback was used. An index-only answer is complete when the evidence supports its timestamped claims. In either path, disclose relevant failures, warnings, sampling or resolution limits, and partial evidence, preserve any images being delivered, and clean every marked workspace created.
