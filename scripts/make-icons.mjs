/**
 * Generates the PNG plugin icons from `favicon.svg`.
 *
 * Zotero requires raster icons in `manifest.json` (48px and 96px), but we do
 * not want to commit binary blobs that no one can review. Running this script
 * writes them from the SVG source; the generated files are committed so a plain
 * `npm run build` never needs this step.
 *
 * Usage: npm run icons
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "addon", "content", "icons");

/** Renders the plugin mark into an RGBA buffer at the requested size. */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const s = size / 32; // the SVG viewBox is 32x32

  const set = (x, y, [r, g, b], alpha = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const a = alpha / 255;
    pixels[i] = Math.round(pixels[i] * (1 - a) + r * a);
    pixels[i + 1] = Math.round(pixels[i + 1] * (1 - a) + g * a);
    pixels[i + 2] = Math.round(pixels[i + 2] * (1 - a) + b * a);
    pixels[i + 3] = Math.max(pixels[i + 3], alpha);
  };
  const fillRect = (x0, y0, x1, y1, colour, alpha = 255) => {
    for (let y = Math.round(y0 * s); y < Math.round(y1 * s); y++) {
      for (let x = Math.round(x0 * s); x < Math.round(x1 * s); x++) set(x, y, colour, alpha);
    }
  };

  const BLUE = [91, 124, 250];
  const PURPLE = [139, 92, 246];
  const GOLD = [255, 209, 102];

  // Rounded-square badge with a diagonal gradient, matching the SVG.
  const radius = 7 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      if (px < s || py < s || px > 31 * s || py > 31 * s) continue;
      // Corner rounding.
      const cx = Math.min(Math.max(px, s + radius), 31 * s - radius);
      const cy = Math.min(Math.max(py, s + radius), 31 * s - radius);
      if (Math.hypot(px - cx, py - cy) > radius) continue;
      const t = (px + py) / (32 * s * 2);
      set(x, y, [
        Math.round(BLUE[0] + (PURPLE[0] - BLUE[0]) * t),
        Math.round(BLUE[1] + (PURPLE[1] - BLUE[1]) * t),
        Math.round(BLUE[2] + (PURPLE[2] - BLUE[2]) * t),
      ]);
    }
  }

  // Document sheet.
  fillRect(10, 7, 18, 25, [255, 255, 255], 242);
  fillRect(18, 7, 22, 11, [235, 238, 250], 242);

  // Text lines.
  for (const y of [14.5, 17.5, 20.5]) {
    fillRect(12.5, y, y === 20.5 ? 16.5 : 19.5, y + 1.2, BLUE, 216);
  }

  // Spark accent.
  const spark = (cx, cy, r) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.abs(x + 0.5 - cx * s) + Math.abs(y + 0.5 - cy * s);
        if (d <= r * s) set(x, y, GOLD);
      }
    }
  };
  spark(23.5, 22.2, 4.6);
  spark(23.5, 22.2, 2.6);

  return pixels;
}

/** Minimal PNG encoder: one IDAT chunk, filter type 0 per scanline. */
function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

mkdirSync(outDir, { recursive: true });
for (const [name, size] of [
  ["favicon.png", 96],
  ["favicon@0.5x.png", 48],
]) {
  const file = join(outDir, name);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file} (${size}x${size})`);
}
