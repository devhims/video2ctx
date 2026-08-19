# Visual context workflow

Use the bundled executable for a progressive visual read. The default scan combines a timed transcript with storyboard contact sheets and does not require FFmpeg.

## Scan the transcript and storyboards

Resolve `scripts/watch.mjs` relative to the parent skill directory containing `SKILL.md`, then extract the 11-character video ID from the supplied YouTube URL.

```bash
node <skill-directory>/scripts/watch.mjs index --video-id 4vItmdk8F_M
```

Parse the JSON response. Read the available timed transcript and, when present, explicitly open every path in `storyboard.sheets` with the available image-viewing tool. Each sheet is a contact sheet. Calculate a tile timestamp with:

```text
(firstFrameIndex + row * columns + column) * intervalMs
```

Use `--granularity word` only when word-level timing materially changes the task.

After reading the index, answer directly when it provides enough evidence for the requested claims. Storyboards are suited to video structure, scene or slide sequences, locating demonstrations, and rough visual changes.

## Verify with exact frames when needed

Extract exact frames when the answer depends on small text, code, chart values, detailed interface state, a brief visual change, a precise comparison, an ambiguous storyboard tile, or a frame the user explicitly requested. Storyboard tiles are sampled and low resolution, so do not use them alone for details they cannot resolve.

Choose no more than 30 timestamps that answer the user's question. Prefer a small, diverse set over adjacent or repetitive moments.

```bash
node <skill-directory>/scripts/watch.mjs frames \
  --workspace <workspace-from-index> \
  --timestamps 30,686,1000
```

Explicitly open every returned `frames[].path` with the image-viewing tool. Keep each image associated with `timestampMs`; a file path alone is not visual context. Reflect `failures` and `meta.warnings` when the answer depends on missing or low-resolution evidence.

If exact frames fail with `DEPENDENCY_MISSING`, continue with a qualified index-only answer when the available evidence supports one. Report that FFmpeg must be installed or supplied with `--ffmpeg-path` when the unresolved question requires exact frames. Do not install system software without user authorization.

## Clean up

After the images have been consumed and the answer is complete, remove only the marked workspace returned by the index operation:

```bash
node <skill-directory>/scripts/watch.mjs cleanup --workspace <workspace-from-index>
```

The cleanup command rejects arbitrary directories. Preserve the workspace until no further image reads are needed.

## Completion criteria

An index-only answer is complete when the available transcript and every storyboard sheet were read, that evidence supports the requested claims, claims are tied to timestamps, sampling or resolution limits and partial evidence are disclosed, and the marked workspace was cleaned. When exact frames are needed or requested, completion also requires every returned frame to be explicitly loaded and relevant failures and warnings to be disclosed.
