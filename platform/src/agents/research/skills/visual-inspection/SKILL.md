---
name: visual-inspection
description: Locate and inspect YouTube images for visible details, resolve conflicts with captions or metadata, and explain recorded frame choices on follow-up.
---

# Visual inspection

Answer visible questions from analyzed images. Metadata and captions locate moments and identify speakers; they do not establish clothing, scenery or readable on-screen text.

## Locate

Reuse adequate saved analysis first. Choose how to locate by what the question needs:

- The look of a whole video, such as camera style, colors, set or diagram style: a small spread of storyboard sheets. Captions add nothing.
- A visual moment with no spoken cue: scan storyboard sheets with an analysis question. One call can include many sheets.
- A moment defined by topic or speech, such as the slide for a named concept or a spoken introduction: use title, description or chapter timestamps first, then captions. Retrieve the transcript without an analysis question and find the passage with search_originals. A transcript analyst never answers visual questions.

A chapter is a timestamped section listed by the publisher, not an inferred scene boundary. In topic research, fetch captions only for videos you will inspect. The last provider calls are kept for get_video_frames, so do not spend them on other retrieval. Respect the user's chosen inspection method.

For a presenter question, an introduction is a lead, not proof the presenter is on screen. A storyboard overview can locate her actual appearance. Prefer a few frames that answer the question over a six-frame quota or unexplained samples across the whole video. Questions about changes across the video need wider coverage.

## Inspect

Use get_video_frames for exact seek positions when storyboard images are too small, text is ambiguous, or captions conflict with visible labels. If storyboard retrieval or analysis fails, switch to get_video_frames with an analysis question while time remains; never repeat the failed storyboard request unchanged. Supply selections with one basis category and the locating evidenceIds for each timestamp. user_requested and exploratory selections cite no excerpts; describe an exploratory sample as exploratory. A basis records the kind of choice, not private reasoning or proof the desired scene exists.

For new images, supply an analysis question to get_video_frames or get_video_storyboard so the images are analyzed while they are saved. Retrieval without analysis provides no observations; a RETRIEVAL_ANALYSIS_FAILED warning means the images were saved but still need analyze_video_frames or analyze_video_storyboard. Inspect only analysisAssetVersions from storyboard results, never the manifest. The runtime supplies title, full description, channel and question to image analysts. Analyze saved images directly for new questions rather than fetching the same images again.

Check whether each requested detail is visible and readable. A transition or irrelevant shot does not answer a clothing question. When needed, try a nearby timestamp informed by the overview, within the remaining time and provider budget. When names conflict, inspect a readable on-screen label at an exact frame and distinguish the label from noisy captions. A name in metadata is context, not visual identification.

## Finish and explain

Present the visible findings with citations and material uncertainty. Explain inspection steps only when the user explicitly asks about the workflow. Finishing transcript research does not finish a visual question. Before finishing, check every requested subject and attribute against analyzed images; stop when they are covered or a real retrieval, analysis or budget limit prevents it, not merely because captions omit visual details. Keep image quality and missing-image warnings. Cite each frame-specific observation at its own timestamp. Describe shared observations only over their supported sampled frames. State missing details and actual retrieval or analysis limits. Sampled stills do not establish continuous appearance or motion.

For a follow-up about how inspection happened, use frameCoverage, selection bases and delivery records. Separate requested or retrieved positions from analyzed frames and storyboard samples. A storyboard analyst receives every tile in the selected sheets; its reported finding times may cover only a subset. Sheet spread selection does not choose 3:20 over 3:30 within the same supplied sheet. A recorded basis can explain why a timestamp was chosen, such as a spoken introduction; what a cited excerpt says is evidence only when that excerpt is supplied. Without a basis, say the reason was not recorded. Do not reconstruct a past rationale from what now seems sensible. Treat user examples such as “why 3:20 instead of 3:30?” as alternatives, not captured frames. Claim transcript reading or fresh image analysis only when the supplied records establish it. Historical evidence and memory alone do not prove a current operation.
