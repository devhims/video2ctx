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

`fragmented-edit.mp4` adds a single preroll edit to the fragmented fixture, matching
YouTube's layout. Reproduce it after generating `fragmented.mp4`:

```python
from pathlib import Path
import struct
b = bytearray(Path('fragmented.mp4').read_bytes())
moov, trak = b.index(b'moov') - 4, b.index(b'trak') - 4
elst = struct.pack('>I4sIIIIHH', 28, b'elst', 0, 1, 4000, 2048, 1, 0)
edts = struct.pack('>I4s', 36, b'edts') + elst
for offset in [moov, trak]:
    struct.pack_into('>I', b, offset, struct.unpack_from('>I', b, offset)[0] + 36)
b[trak + 8:trak + 8] = edts
Path('fragmented-edit.mp4').write_bytes(b)
```
