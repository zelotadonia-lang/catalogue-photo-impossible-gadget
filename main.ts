// The Catalogue Photo of an Impossible Gadget
// Node 22, standard library only, no network. Renders one 1024x1024
// studio catalogue photograph of a solar-powered flashlight whose only
// power source is a miniature sun kept in a glass jar beside it, wired
// to the flashlight. Writes /output/entry.png (or $MAKEFUN_OUTPUT_DIR).
//
// The picture is drawn pixel by pixel into an RGB buffer: a clean studio
// backdrop, a soft floor shadow, the flashlight as hero, the jarred sun
// as the single accessory, and a beam of light. The buffer is encoded
// as a PNG by hand (zlib from node:zlib, CRC32 table below).

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';

const W = 1024;
const H = 1024;
const MAX_BYTES = 1048576;

// ---------------------------------------------------------------------------
// Pixel buffer and blending helpers
// ---------------------------------------------------------------------------

const img = new Uint8Array(W * H * 3);

type RGB = [number, number, number];

function idx(x: number, y: number): number {
  return (y * W + x) * 3;
}

// Paint one pixel, blending colour over what is already there.
function put(x: number, y: number, c: RGB, a: number): void {
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  if (a > 1) a = 1;
  const i = idx(x, y);
  const inv = 1 - a;
  img[i] = c[0] * a + img[i] * inv;
  img[i + 1] = c[1] * a + img[i + 1] * inv;
  img[i + 2] = c[2] * a + img[i + 2] * inv;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Smooth step for soft edges: 0 below lo, 1 above hi.
function smooth(lo: number, hi: number, v: number): number {
  const t = clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

// Filled ellipse with a soft 1.5px edge. Colour may vary with position.
function ellipse(
  cx: number, cy: number, rx: number, ry: number,
  col: (x: number, y: number) => [RGB, number],
): void {
  const x0 = Math.max(0, Math.floor(cx - rx - 2));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx + 2));
  const y0 = Math.max(0, Math.floor(cy - ry - 2));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const d = dx * dx + dy * dy;
      if (d > 1.05) continue;
      const edge = 1 - smooth(0.92, 1.0, d);
      const [c, a] = col(x, y);
      put(x, y, c, a * edge);
    }
  }
}

// Filled rounded rectangle. Colour may vary with position.
function roundRect(
  x0: number, y0: number, x1: number, y1: number, r: number,
  col: (x: number, y: number) => [RGB, number],
): void {
  const ix0 = Math.max(0, Math.floor(x0 - 2));
  const ix1 = Math.min(W - 1, Math.ceil(x1 + 2));
  const iy0 = Math.max(0, Math.floor(y0 - 2));
  const iy1 = Math.min(H - 1, Math.ceil(y1 + 2));
  for (let y = iy0; y <= iy1; y++) {
    for (let x = ix0; x <= ix1; x++) {
      const cx = clamp(x + 0.5, x0 + r, x1 - r);
      const cy = clamp(y + 0.5, y0 + r, y1 - r);
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r + 1) continue;
      const edge = 1 - smooth(r - 1, r + 0.5, d);
      const [c, a] = col(x, y);
      put(x, y, c, a * edge);
    }
  }
}

// A thick line with round caps, drawn as a chain of discs.
function thickLine(
  x0: number, y0: number, x1: number, y1: number, w: number,
  c: RGB, a: number,
): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len / (w * 0.4)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    ellipse(lerp(x0, x1, t), lerp(y0, y1, t), w / 2, w / 2, () => [c, a]);
  }
}

// Radial glow: adds colour fading with distance from a centre point.
function glow(
  cx: number, cy: number, radius: number, c: RGB, strength: number,
): void {
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(W - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(H - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / radius;
      if (d >= 1) continue;
      const fall = (1 - d) * (1 - d);
      put(x, y, c, strength * fall);
    }
  }
}

// ---------------------------------------------------------------------------
// Tiny 5x7 bitmap font for the small brand label printed on the product.
// Only the glyphs the label needs.
// ---------------------------------------------------------------------------

const FONT: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.###.', '#...#', '#....', '.###.', '....#', '#...#', '.###.'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

function drawText(
  text: string, x: number, y: number, scale: number, c: RGB, a: number,
): void {
  let cx = x;
  for (const ch of text) {
    const glyph = FONT[ch];
    if (glyph) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] === '#') {
            for (let sy = 0; sy < scale; sy++) {
              for (let sx = 0; sx < scale; sx++) {
                put(cx + col * scale + sx, y + row * scale + sy, c, a);
              }
            }
          }
        }
      }
    }
    cx += 6 * scale;
  }
}

// ---------------------------------------------------------------------------
// PNG encoding: IHDR / IDAT (zlib deflate, per-row filter pick) / IEND.
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(): Buffer {
  const stride = W * 3;
  const raw = Buffer.alloc(H * (stride + 1));
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < H; y++) {
    const row = Buffer.from(img.subarray(y * stride, (y + 1) * stride));
    // Try filters None, Sub and Up; keep the one with the smallest
    // sum of absolute signed bytes, which deflate compresses best.
    let best: Buffer | null = null;
    let bestScore = Infinity;
    for (const filter of [0, 1, 2]) {
      const out = Buffer.alloc(stride + 1);
      out[0] = filter;
      let score = 0;
      for (let i = 0; i < stride; i++) {
        let v = row[i];
        if (filter === 1) v = (v - (i >= 3 ? row[i - 3] : 0)) & 0xff;
        else if (filter === 2) v = (v - prev[i]) & 0xff;
        out[i + 1] = v;
        const s = v < 128 ? v : v - 256;
        score += s < 0 ? -s : s;
      }
      if (score < bestScore) {
        bestScore = score;
        best = out;
      }
    }
    best!.copy(raw, y * (stride + 1));
    row.copy(prev);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    magic,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

const TOP: RGB = [247, 244, 238];
const BOTTOM: RGB = [214, 208, 192];

function drawBackground(): void {
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    const base: RGB = [
      lerp(TOP[0], BOTTOM[0], t),
      lerp(TOP[1], BOTTOM[1], t),
      lerp(TOP[2], BOTTOM[2], t),
    ];
    for (let x = 0; x < W; x++) {
      // Soft studio light pooling in the middle of the backdrop.
      const d = Math.hypot(x - 520, y - 430) / 720;
      const lift = Math.max(0, 1 - d) * 9;
      const i = idx(x, y);
      img[i] = base[0] + lift;
      img[i + 1] = base[1] + lift;
      img[i + 2] = base[2] + lift;
    }
  }
}

function drawFloorShadow(): void {
  ellipse(500, 838, 340, 40, () => [[58, 48, 32], 0.16]);
  ellipse(500, 836, 295, 30, () => [[58, 48, 32], 0.10]);
  ellipse(430, 822, 125, 22, () => [[50, 42, 28], 0.20]);
  ellipse(730, 822, 115, 20, () => [[50, 42, 28], 0.18]);
}

// The beam: a cone of warm light rising from the lens, fading with height.
function drawBeam(): void {
  const cx = 430;
  const yLens = 335;
  const yTop = 24;
  for (let y = yTop; y <= yLens; y++) {
    const t = (yLens - y) / (yLens - yTop); // 0 at top, 1 at the lens
    const halfW = lerp(150, 34, t);
    const x0 = Math.max(0, Math.floor(cx - halfW));
    const x1 = Math.min(W - 1, Math.ceil(cx + halfW));
    for (let x = x0; x <= x1; x++) {
      const lat = 1 - Math.abs(x + 0.5 - cx) / halfW;
      const a = 0.38 * Math.pow(t, 1.4) * Math.pow(lat, 0.8);
      put(x, y, [255, 232, 160], a);
    }
  }
}

// Metal gradient across a horizontal span: dark edges, bright stripe.
function metalGradient(
  x: number, x0: number, x1: number,
  dark: RGB, mid: RGB, bright: RGB,
): RGB {
  const t = (x - x0) / (x1 - x0);
  if (t < 0.28) {
    const u = t / 0.28;
    return [lerp(dark[0], bright[0], u), lerp(dark[1], bright[1], u), lerp(dark[2], bright[2], u)];
  }
  if (t < 0.55) {
    const u = (t - 0.28) / 0.27;
    return [lerp(bright[0], mid[0], u), lerp(bright[1], mid[1], u), lerp(bright[2], mid[2], u)];
  }
  const u = (t - 0.55) / 0.45;
  return [lerp(mid[0], dark[0], u), lerp(mid[1], dark[1], u), lerp(mid[2], dark[2], u)];
}

function drawFlashlight(): void {
  const x0 = 355;
  const x1 = 505;

  // Body: gunmetal tube, darker towards the base.
  roundRect(x0, 400, x1, 805, 14, (x, y) => {
    const c = metalGradient(x, x0, x1, [36, 39, 46], [76, 81, 92], [112, 118, 132]);
    const shade = 1 - 0.12 * ((y - 400) / 405);
    return [[c[0] * shade, c[1] * shade, c[2] * shade], 1];
  });

  // Knurled grip: three dark bands with a thin highlight under each.
  for (const gy of [565, 605, 645]) {
    roundRect(x0 + 2, gy, x1 - 2, gy + 20, 6, () => [[20, 22, 27], 0.9]);
    thickLine(x0 + 6, gy + 23, x1 - 6, gy + 23, 2, [200, 205, 215], 0.18);
  }

  // Solar panel on the body, tilted towards its little sun.
  roundRect(386, 450, 474, 524, 6, (x, y) => {
    const t = (y - 450) / 74;
    return [[lerp(16, 34, t), lerp(28, 54, t), lerp(52, 96, t)], 1];
  });
  for (let gx = 402; gx <= 462; gx += 15) {
    thickLine(gx, 454, gx, 520, 1, [140, 178, 235], 0.65);
  }
  for (let gy = 468; gy <= 508; gy += 14) {
    thickLine(390, gy, 470, gy, 1, [140, 178, 235], 0.65);
  }

  // Tail cap.
  roundRect(x0, 768, x1, 805, 12, () => [[30, 32, 38], 1]);

  // Bezel: polished silver ring above the body.
  roundRect(340, 330, 520, 412, 16, (x) => [
    metalGradient(x, 340, 520, [140, 145, 152], [176, 181, 190], [232, 235, 240]),
    1,
  ]);
  thickLine(346, 408, 514, 408, 3, [90, 94, 102], 0.5);

  // Lens: warm glowing glass.
  glow(430, 348, 120, [255, 220, 140], 0.45);
  ellipse(430, 348, 60, 24, (x, y) => {
    const d = Math.hypot((x - 430) / 60, (y - 348) / 24);
    const t = clamp(d, 0, 1);
    return [
      [lerp(255, 255, t), lerp(250, 214, t), lerp(220, 130, t)],
      1,
    ];
  });
  ellipse(412, 342, 20, 7, () => [[255, 255, 255], 0.75]);

  // Brand label printed on the product, and nothing else.
  drawText('SOLARFLASH', 370, 700, 2, [226, 229, 233], 0.92);
  drawText('SUN-1', 415, 726, 1, [190, 194, 200], 0.85);

  // Charging LED, lit green: the sun is feeding it.
  ellipse(488, 748, 5, 5, () => [[120, 255, 140], 1]);
  glow(488, 748, 16, [120, 255, 140], 0.5);
}

// The single accessory: a miniature sun in a glass jar, wired to the torch.
function drawSunJar(): void {
  const cx = 730;
  const cy = 675;

  glow(cx, cy, 195, [255, 170, 60], 0.32);

  // Twelve short rays around the little sun.
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    thickLine(
      cx + Math.cos(a) * 56, cy + Math.sin(a) * 56,
      cx + Math.cos(a) * 74, cy + Math.sin(a) * 74,
      7, [255, 170, 40], 0.9,
    );
  }

  // The sun itself: white-hot core to orange rim.
  ellipse(cx, cy, 52, 52, (x, y) => {
    const d = clamp(Math.hypot(x - cx, y - cy) / 52, 0, 1);
    if (d < 0.35) return [[255, 248, 205], 1];
    if (d < 0.75) {
      const u = (d - 0.35) / 0.4;
      return [[255, lerp(248, 190, u), lerp(205, 60, u)], 1];
    }
    const u = (d - 0.75) / 0.25;
    return [[255, lerp(190, 122, u), lerp(60, 20, u)], 1];
  });

  // Glass jar over the sun.
  roundRect(650, 548, 810, 805, 18, () => [[255, 255, 255], 0.08]);
  roundRect(662, 566, 672, 790, 5, () => [[255, 255, 255], 0.30]);
  roundRect(788, 566, 796, 790, 4, () => [[255, 255, 255], 0.16]);
  ellipse(cx, 550, 80, 12, () => [[235, 238, 242], 0.35]);

  // Metal screw lid.
  roundRect(644, 520, 816, 550, 8, (x) => [
    metalGradient(x, 644, 816, [120, 124, 130], [158, 162, 170], [215, 218, 224]),
    1,
  ]);
  thickLine(650, 552, 810, 552, 3, [70, 74, 82], 0.5);
}

// Power cable from the jar to the flashlight, sagging between them.
function drawCable(): void {
  const p0 = [502, 792];
  const p1 = [578, 846];
  const p2 = [654, 792];
  let prevX = p0[0];
  let prevY = p0[1];
  for (let s = 1; s <= 36; s++) {
    const t = s / 36;
    const x = (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0];
    const y = (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1];
    thickLine(prevX, prevY, x, y, 7, [35, 33, 30], 0.95);
    prevX = x;
    prevY = y;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  drawBackground();
  drawFloorShadow();
  drawCable();
  drawBeam();
  drawFlashlight();
  drawSunJar();

  const png = encodePNG();
  if (png.length > MAX_BYTES) {
    throw new Error(`entry.png is ${png.length} bytes, over the 1 MiB limit`);
  }
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'entry.png'), png);
  console.log(`wrote ${join(outDir, 'entry.png')} (${png.length} bytes, 1024x1024)`);
}

main();
