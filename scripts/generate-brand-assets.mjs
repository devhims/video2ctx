import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const manifestPath = resolve(root, 'brand/generated-assets.json');
const sourcePaths = [
  'brand/source/video2ctx-logo.png',
  'brand/source/video2ctx-logo-192.png',
  'brand/source/video2ctx-favicon-32.png',
  'brand/source/video2ctx-favicon.ico',
  // Purpose-built for the card: mass on the right, near-black on the left, and
  // the same carved symbols as the landing fold. Not the hero still — that one
  // fills the frame, so text over it needs a scrim, and a scrim over a scene
  // this dark lifts the blacks rather than deepening them.
  'brand/source/video2ctx-og-background-hybrid-icons.png',
];
const outputPaths = [
  'web/public/brand/logo-120.png',
  'web/public/android-chrome-192x192.png',
  'web/public/android-chrome-512x512.png',
  'web/app/icon.png',
  'web/app/apple-icon.png',
  'web/app/favicon.ico',
  'web/app/opengraph-image.jpg',
  'web/app/twitter-image.jpg',
  'docs/favicon.png',
  'docs/logo/light.svg',
  'docs/logo/dark.svg',
  'platform/src/generated/brand.ts',
];

function absolute(relativePath) {
  return resolve(root, relativePath);
}

function hash(relativePath) {
  return createHash('sha256').update(readFileSync(absolute(relativePath))).digest('hex');
}

function ensureParent(relativePath) {
  mkdirSync(dirname(absolute(relativePath)), { recursive: true });
}

function write(relativePath, content) {
  ensureParent(relativePath);
  writeFileSync(absolute(relativePath), content);
}

function copy(sourcePath, outputPath) {
  ensureParent(outputPath);
  copyFileSync(absolute(sourcePath), absolute(outputPath));
}

function wordmark(logoDataUrl, color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 256" role="img" aria-labelledby="title">
  <title id="title">video2ctx</title>
  <image href="${logoDataUrl}" x="0" y="0" width="256" height="256"/>
  <text x="304" y="168" fill="${color}" font-family="Arial, Helvetica, sans-serif" font-size="116" font-weight="700" letter-spacing="-4">video2ctx</text>
</svg>
`;
}

/* Type here tracks `.craft-nav-wordmark` in craft.css: Geist at weight 670 with
 * -0.035em tracking. Geist ships static TTFs at 600 and 700, and 670 sits
 * between them, so the card uses Bold as the nearest neighbour rather than a
 * variable axis — librsvg does not reliably honour `font-variation-settings`.
 *
 * The navbar renders its `ctx` suffix in Geist Pixel Grid. That cannot be
 * reproduced here: geist ships the pixel family as woff2 only, and librsvg
 * silently ignores woff2 @font-face and falls back. So the card's wordmark is
 * Geist throughout. Converting the woff2 to TTF would fix it. */
function openGraphOverlay(logoDataUrl, fontSemiBold, fontBold) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <style>
      @font-face { font-family: 'Geist'; src: url('${fontSemiBold}') format('truetype'); font-weight: 600; }
      @font-face { font-family: 'Geist'; src: url('${fontBold}') format('truetype'); font-weight: 700; }
      .geist { font-family: 'Geist', Arial, Helvetica, sans-serif; }
    </style>
  </defs>
  <image href="${logoDataUrl}" x="72" y="68" width="76" height="76"/>
  <text class="geist" x="165" y="122" fill="#f5f1eb" font-size="50" font-weight="700" letter-spacing="-1.75">video2ctx</text>
  <text class="geist" x="72" y="266" fill="#f5f1eb" font-size="64" font-weight="700" letter-spacing="-2.24">Video context</text>
  <text class="geist" x="72" y="338" fill="#f5f1eb" font-size="64" font-weight="700" letter-spacing="-2.24">for agents</text>
  <text class="geist" x="74" y="408" fill="#b7b1aa" font-size="23" font-weight="600" letter-spacing="-0.5">Structured, source-linked context from video.</text>
  <text class="geist" x="74" y="552" fill="#ef5a4f" font-size="20" font-weight="600" letter-spacing="0.3">video2ctx.dev</text>
</svg>`;
}

async function generate() {
  const sourceLogoPath = absolute(sourcePaths[0]);
  await sharp(sourceLogoPath)
    .resize(120, 120)
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(absolute('web/public/brand/logo-120.png'));

  copy(sourcePaths[0], 'web/app/icon.png');
  copy(sourcePaths[0], 'web/public/android-chrome-512x512.png');
  copy(sourcePaths[1], 'web/public/android-chrome-192x192.png');
  copy(sourcePaths[3], 'web/app/favicon.ico');
  copy(sourcePaths[2], 'docs/favicon.png');

  await sharp(sourceLogoPath)
    .resize(180, 180)
    .flatten({ background: '#f03a36' })
    .png({ palette: true, colours: 256, compressionLevel: 9 })
    .toFile(absolute('web/app/apple-icon.png'));

  const ogLogoDataUrl = `data:image/png;base64,${readFileSync(sourceLogoPath).toString('base64')}`;
  const ogFontDataUrl = `data:font/ttf;base64,${readFileSync(
    absolute('web/node_modules/geist/dist/fonts/geist-sans/Geist-SemiBold.ttf'),
  ).toString('base64')}`;
  const ogFontBoldDataUrl = `data:font/ttf;base64,${readFileSync(
    absolute('web/node_modules/geist/dist/fonts/geist-sans/Geist-Bold.ttf'),
  ).toString('base64')}`;
  /* Centre-cropped and ungraded, both deliberate. This source is already
   * composed and exposed for a card, unlike the hero still, which is graded to
   * sit under a 64% dimmer and needs a brightness lift to survive a feed.
   *
   * There is also no scrim. The left of this frame is darker than #171513, so
   * any scrim over it *raises* the black point instead of lowering it —
   * measured, a 55% wipe took the text plate from 17.9 up to 23.8. */
  await sharp(absolute(sourcePaths[4]))
    .resize(1200, 630, { fit: 'cover', position: 'centre' })
    .composite([{ input: Buffer.from(openGraphOverlay(ogLogoDataUrl, ogFontDataUrl, ogFontBoldDataUrl)) }])
    /* JPEG, not PNG. The card is a dark photographic gradient with no flat
     * colour and no transparency, which is PNG's worst case — it was 690 KB as
     * a PNG against 152 KB here. Banding was the thing to check, since the
     * frame is mostly near-black, and it does not appear: peak error against
     * the lossless original measured 1/255 across the gradient.
     *
     * 4:4:4 is deliberate. The logo and the URL are saturated red, and chroma
     * subsampling is exactly where those edges smear. */
    .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: '4:4:4' })
    .toFile(absolute('web/app/opengraph-image.jpg'));
  copy('web/app/opengraph-image.jpg', 'web/app/twitter-image.jpg');

  const navLogoDataUrl = `data:image/png;base64,${readFileSync(absolute('web/public/brand/logo-120.png')).toString('base64')}`;
  write('docs/logo/light.svg', wordmark(navLogoDataUrl, '#191715'));
  write('docs/logo/dark.svg', wordmark(navLogoDataUrl, '#f5f1eb'));

  const faviconDataUrl = `data:image/png;base64,${readFileSync(absolute(sourcePaths[2])).toString('base64')}`;
  write(
    'platform/src/generated/brand.ts',
    `// Generated by scripts/generate-brand-assets.mjs. Do not edit directly.\nexport const video2ctxFavicon = ${JSON.stringify(faviconDataUrl)};\n`,
  );

  const files = Object.fromEntries([...sourcePaths, ...outputPaths].map((path) => [path, hash(path)]));
  write('brand/generated-assets.json', `${JSON.stringify({ files }, null, 2)}\n`);
}

function check() {
  if (!existsSync(manifestPath)) throw new Error('Brand manifest is missing. Run `npm run brand:generate`.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const failures = [];
  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    const absolutePath = absolute(relativePath);
    if (!existsSync(absolutePath)) failures.push(`${relativePath} is missing`);
    else if (hash(relativePath) !== expectedHash) failures.push(`${relativePath} is out of date`);
  }
  if (failures.length) {
    throw new Error(`Brand assets are not synchronized:\n- ${failures.join('\n- ')}\nRun \`npm run brand:generate\`.`);
  }
  console.log(`Brand assets verified (${Object.keys(manifest.files).length} files).`);
}

if (checkOnly) check();
else await generate();
