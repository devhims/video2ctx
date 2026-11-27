import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runFfmpeg } from './media';
import { runCommand } from './ytdlp';

/** A face (or keep-out area) in output pixels on the 1080x1920 frame. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceSample {
  atSec: number;
  boxes: Box[];
}

const SAMPLE_FPS = 2;
const FRAME_W = 1080;
const FRAME_H = 1920;

/**
 * macOS Vision through JavaScript for Automation: no install, about 10 ms a frame.
 * Prints [{ path, faces: [{ x, y, w, h }] }] with top-left origin, as fractions of the image.
 */
const VISION_SCRIPT = `ObjC.import('Vision');
function run(argv) {
  const out = [];
  for (const path of argv) {
    const handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(path), $({}));
    const request = $.VNDetectFaceRectanglesRequest.alloc.init;
    handler.performRequestsError($([request]), Ref());
    const faces = [];
    const results = request.results;
    for (let i = 0; i < results.count; i++) {
      const box = results.objectAtIndex(i).boundingBox;
      faces.push({ x: box.origin.x, y: 1 - box.origin.y - box.size.height, w: box.size.width, h: box.size.height });
    }
    out.push({ path, faces });
  }
  return JSON.stringify(out);
}`;

/**
 * A small margin around a detected face. Vision's box runs from about the brows to the chin, so
 * the keep-out protects eyes, nose, and mouth while letting text sit over hair or background.
 */
export function padFace(box: Box): Box {
  return { x: box.x - box.w * 0.04, y: box.y - box.h * 0.1, w: box.w * 1.08, h: box.h * 1.14 };
}

/** Detect faces in a rendered vertical short twice a second. Returns undefined where Vision is unavailable. */
export async function detectFaces(ffmpeg: string, video: string, platform = process.platform): Promise<FaceSample[] | undefined> {
  if (platform !== 'darwin') return undefined;
  const work = await mkdtemp(join(tmpdir(), 'shorts-faces-'));
  try {
    const frames = await runFfmpeg(ffmpeg, ['-i', video, '-vf', `fps=${SAMPLE_FPS},scale=540:-2`, '-q:v', '4', join(work, 'f%05d.jpg')]);
    if (frames.code !== 0) return undefined;
    const files = (await readdir(work)).filter((name) => name.endsWith('.jpg')).sort();
    if (!files.length) return undefined;
    const script = join(work, 'faces.js');
    await writeFile(script, VISION_SCRIPT);
    const result = await runCommand('/usr/bin/osascript', ['-l', 'JavaScript', script, ...files.map((name) => join(work, name))], 5 * 60_000);
    if (result.code !== 0) return undefined;
    const parsed = JSON.parse(result.stdout.trim()) as Array<{ path: string; faces: Box[] }>;
    return parsed.map((entry, index) => ({
      atSec: index / SAMPLE_FPS,
      boxes: entry.faces.map((face) => padFace({ x: face.x * FRAME_W, y: face.y * FRAME_H, w: face.w * FRAME_W, h: face.h * FRAME_H })),
    }));
  } catch {
    return undefined;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
