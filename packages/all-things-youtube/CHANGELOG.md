# Changelog

## 0.6.0

- Save native WebP storyboards as `.webp`, including when YouTube serves them from a `.jpg` URL. JPEG output remains `.jpg`. Callers must use the returned `sheet.path` instead of assuming the extension. No runtime dependencies were added.
- Validate WebP RIFF/chunk boundaries and still-image headers within the existing 4 MiB sheet limit. Reject unsupported MIME types, malformed containers, and animated WebP.
- Include the alternate-client and desktop storyboard discovery fixes from PR44. All player attempts share a 30-second budget, and blocked clients no longer produce a definitive `NOT_FOUND` result.
- Preserve selection, tile coordinates, and timestamp mappings for both formats.
- Add deterministic WebP fixtures and a clean-tarball smoke test for CommonJS, ESM, and desktop fallback.

The hosted processor continues converting WebP to JPEG for its existing HTTP contract.
