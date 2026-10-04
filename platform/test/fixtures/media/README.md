# Synthetic MP4 fixtures

These files contain a generated FFmpeg test pattern, with no third-party footage.
All are four seconds at 64 × 48 and 12 fps, with H.264 B-frames and one keyframe per second.
`fragmented.mp4` contains indexed fragments with a nonzero starting PTS.
`indexed.mp4` has a front index; `tail-index.mp4` has an index after its media bytes.

Regenerate with FFmpeg:

```sh
ffmpeg -f lavfi -i testsrc2=size=64x48:rate=12 -t 4 -c:v libx264 -g 12 -keyint_min 12 -sc_threshold 0 -bf 2 -pix_fmt yuv420p -movflags +faststart indexed.mp4
ffmpeg -i indexed.mp4 -c copy tail-index.mp4
ffmpeg -f lavfi -i testsrc2=size=64x48:rate=12 -t 4 -c:v libx264 -g 12 -keyint_min 12 -sc_threshold 0 -bf 2 -pix_fmt yuv420p -movflags +dash+global_sidx fragmented.mp4
```
