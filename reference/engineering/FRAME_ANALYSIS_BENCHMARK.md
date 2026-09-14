# Frame analyst latency replay

Measured on September 14, 2026, using the five saved JPEGs from video `hMvkGLfDAJg` at 120, 240, 360, 480 and 600 seconds. All images are 640 by 360, totaling 243,632 bytes. No images were resized or regenerated. The user explicitly authorized sending these images to Fireworks for this verification.

The benchmark calls the real `createFrameAnalyst` and `createAgentModel` implementations with GLM 5.3 Flash on Fireworks, the existing model settings, temperature 0, no retries and the existing 20-second analysis deadline. It uses the original follow-up question and the narrow jersey-back focus from the production trace. Timers start before reading and base64-encoding the saved JPEGs and end after the analyst returns validated findings.

This measures the complete **saved-image analysis call** from the developer machine. It excludes YouTube format resolution, FFmpeg extraction, container startup, R2 reads/writes, classification and final-answer generation. The old production trace did not separate those phases, so subtracting this replay duration from the earlier 32-second frame call would not be a valid extraction measurement.

## Change and results

The baseline is the revised analyst in commit `88435b8`, before concise literal-output instructions were added. It found the names but sometimes expanded first names without citing the supporting image, guessed illegible jersey letters, or suggested an unsupported identity. The additional instruction requests short, relevant findings, literal names, no guessed expansions, and no unrelated scores or statistics. The output-token ceiling remains unchanged so complex visual questions retain room to answer.

| Measurement | Baseline, 5 calls | Concise, 8 calls |
| --- | ---: | ---: |
| Mean complete analysis | 8.138 s | 4.892 s |
| Median complete analysis | 8.284 s | 4.974 s |
| Range | 5.856 to 10.034 s | 2.998 to 7.922 s |
| Mean output tokens | 414 | 217.25 |
| Mean server time to first token | 0.637 s | 0.640 s |
| Mean server processing after first token | 6.192 s | 3.307 s |
| Mean elapsed time outside reported server processing | 1.309 s | 0.944 s |
| Mean file reading and encoding | 0.706 ms | 0.739 ms |
| Mean post-model validation/return | 1.249 ms | 0.742 ms |
| HTTP success | 5/5 | 8/8 |

Mean complete analysis improved by 39.9% over all measured calls. The controlled subset of three alternating baseline/concise pairs improved from 7.571 s to 3.748 s, or 50.5%. Two final replays through the edited source, without the experimental prompt wrapper, took 7.922 s and 5.004 s and produced the same readable names. This variation is why 3.75 seconds is not a promised production latency.

Chronological measurements, seconds:

- Initial baseline: 8.284, 9.689.
- Initial concise experiment: 6.635, 3.313, 5.019.
- Alternating pairs: baseline 10.034 / concise 4.945; baseline 6.824 / concise 3.300; baseline 5.856 / concise 2.998.
- Edited-source confirmation: 7.922, 5.004.

All calls reported zero cached prompt tokens and zero reasoning tokens. The concise prompt increased input from 1,910 to 1,994 tokens and request payload from 328,051 to 328,484 bytes while reducing generated output. The measured bottleneck was output generation, not local image encoding. The approximately unchanged server time to first token gives no evidence that reducing image quality would materially improve this sample.

Server timing comes from Fireworks response headers `fireworks-server-processing-time` and `fireworks-server-time-to-first-token`. Their difference is an estimate of server processing after first token, not a GPU profiler measurement. The remaining client duration combines transport, connection setup, unreported provider overhead and local SDK work; it is not a pure network or upload measurement. See [Fireworks performance metrics](https://docs.fireworks.ai/api-reference/post-completions).

## Visual verification

The saved originals were inspected and compared with the outputs. All eight concise calls retained these visible names and supplied the corresponding frame timestamps:

| Frame | Readable evidence |
| --- | --- |
| 120 s | SMRITI and SHAFALI in India's batting scoreboard |
| 240 s | SHAFALI VERMA, SMRITI MANDHANA, RICHA GHOSH in a fastest-fifty graphic containing historical records |
| 360 s | RICHA and HARMANPREET in India's batting scoreboard |
| 480 s | DEEPTI and BHARTI in India's batting scoreboard |
| 600 s | KRANTI GAUD in a player graphic with India's flag |

The concise outputs did not guess an identity for the unreadable jersey name at 480 s. First names remain first names where that is all the image shows. The historical graphic alone does not prove participation in the current match. Some responses still repeated a finding in a warning despite the instruction; that did not change the visible-name evidence.

This is one video, five small frames, and thirteen total model calls. It verifies the missed-name regression on these images and supports a latency improvement, not a broad OCR accuracy score, tail-latency guarantee, or production extraction benchmark. No production deployment was performed.

The local measurement script and detailed JSON outputs are retained under `/tmp/video2ctx-session-check/`: `benchmark-analyst.mts`, `analyst-benchmark.json`, `analyst-benchmark-concise.json`, `analyst-benchmark-compare.json`, `analyst-benchmark-implemented.json`, and `analyst-benchmark-summary.json`. No credentials or raw model reasoning were written to these artifacts.
