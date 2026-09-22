# Changelog

## 0.6.1

- Validate upstream caption URLs and refresh malformed or missing URLs within the existing retry limit. Try usable alternate player metadata and desktop tracks instead of treating URL parsing failures as invalid caller input.
- Preserve explicit source language and track selection during recovery; prefer an available native track for the requested output language.
- Return a retryable `INVALID_RESPONSE` when an existing track has no usable URL. Keep invalid video IDs terminal and omit unusable tracks from the public caption catalog with a partial-data warning.
- Retry explicitly retryable request-preparation failures. Retry events now distinguish `preparation` from HTTP response and network failures and include a safe error code.

## 0.6.0

- Save native WebP storyboards as `.webp`, including when YouTube serves them from a `.jpg` URL. JPEG output remains `.jpg`. Callers must use the returned `sheet.path` instead of assuming the extension. No runtime dependencies were added.
- Validate WebP RIFF/chunk boundaries and still-image headers within the existing 4 MiB sheet limit. Reject unsupported MIME types, malformed containers, and animated WebP.
- Include the alternate-client and desktop storyboard discovery fixes from PR44. All player attempts share a 30-second budget, and blocked clients no longer produce a definitive `NOT_FOUND` result.
- Preserve selection, tile coordinates, and timestamp mappings for both formats.
- Add deterministic WebP fixtures and a clean-tarball smoke test for CommonJS, ESM, and desktop fallback.

The hosted processor continues converting WebP to JPEG for its existing HTTP contract.
