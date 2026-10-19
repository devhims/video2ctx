/** L2-normalized embedding vectors, stored as float16 in base64 inside catalog JSON. */

export function normalize(vector: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Embedding vector has no magnitude.');
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
  return out;
}

/** Similarity of normalized vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('Embedding dimensions differ.');
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** IEEE 754 half precision, round to nearest even. Normalized components never overflow it. */
export function toHalf(value: number): number {
  f32[0] = value;
  const bits = u32[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  let half = exponent - 127 + 15;
  if (half >= 0x1f) return sign | 0x7c00;
  if (half <= 0) {
    if (half < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - half;
    let rounded = mantissa >>> shift;
    const remainder = mantissa & ((1 << shift) - 1);
    const midpoint = 1 << (shift - 1);
    if (remainder > midpoint || (remainder === midpoint && (rounded & 1))) rounded++;
    return sign | rounded;
  }
  let rounded = mantissa >>> 13;
  const remainder = mantissa & 0x1fff;
  if (remainder > 0x1000 || (remainder === 0x1000 && (rounded & 1))) {
    rounded++;
    if (rounded === 0x400) { rounded = 0; half++; }
    if (half >= 0x1f) return sign | 0x7c00;
  }
  return sign | (half << 10) | rounded;
}

export function fromHalf(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >>> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

export function encodeVector(vector: Float32Array): string {
  const bytes = new Uint8Array(vector.length * 2);
  for (let i = 0; i < vector.length; i++) {
    const half = toHalf(vector[i]!);
    bytes[2 * i] = half & 0xff;
    bytes[2 * i + 1] = half >>> 8;
  }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function decodeVector(encoded: string, dims: number): Float32Array {
  const binary = atob(encoded);
  if (binary.length !== dims * 2) throw new Error('Stored vector has the wrong dimension.');
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i++) out[i] = fromHalf(binary.charCodeAt(2 * i) | (binary.charCodeAt(2 * i + 1) << 8));
  return out;
}
