# Fold background scene

Source artwork for the landing fold, generated with GPT Image 2 and committed as
webp only — the PNG originals are ~2 MB each and are not kept in the repo.

| File | Size | Serves |
| --- | --- | --- |
| `voxel-horizon.webp` | 1672 × 941 | desktop and laptop |
| `voxel-horizon-portrait.webp` | 1086 × 1448 | portrait phones and tablets |
| `voxel-horizon-900.webp` | 900 wide | narrow landscape, e.g. a rotated phone |

`<picture>` resolves exactly one of these per visitor; the totals here are not
page weight.

## Regenerating

Method and prompting guidance: `docs/HIGGSFIELD_ASSET_GUIDE.md`.


Prompts and the exact settings are in `docs/CINEMATIC_ASSETS.md`. To re-encode a
new PNG:

```bash
cwebp -quiet -q 82 -m 6 voxel-horizon.png -o voxel-horizon.webp
cwebp -quiet -q 78 -m 6 -resize 900 0 voxel-horizon.png -o voxel-horizon-900.webp
```

Quality 82 rather than the visually-identical 72 is deliberate: the scene is
mostly near-black, and dark gradients are where webp banding shows first. There
is no automated build step — these are committed artefacts.

Compositing (dimming, mask, parallax, flashlight) is all in `web/app/craft.css`,
so the look can be retuned without regenerating anything.
