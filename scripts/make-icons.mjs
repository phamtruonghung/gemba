// scripts/make-icons.mjs — one-off: writes the app icons into public/icons/. Pure node (zlib for the
// PNG container), no dependencies. Run `node scripts/make-icons.mjs` and commit the output; the server
// never runs this. The mark is the brand "G" in on-accent ink on brand orange (design-system tokens).
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const ORANGE = [0xea, 0x58, 0x0c];
const INK = [0x1a, 0x0d, 0x03];

// The G on a 512 grid: a ring of mid-radius 130 and stroke 56, open between -40deg and 0deg (upper
// right), plus the crossbar from the centre out to the ring's outer edge.
const R = 130, W = 56;
function inGlyph(x, y) { // x, y in 512-space, centre (256,256)
  const dx = x - 256, dy = y - 256;
  const d = Math.hypot(dx, dy);
  if (d >= R - W / 2 && d <= R + W / 2) {
    const a = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (!(a > -40 && a < 0)) return true;
  }
  return dx >= 0 && dx <= R + W / 2 && Math.abs(dy) <= W / 2;
}
function inRoundRect(x, y, rx) {
  const cx = Math.min(Math.max(x, rx), 512 - rx), cy = Math.min(Math.max(y, rx), 512 - rx);
  return Math.hypot(x - cx, y - cy) <= rx;
}

function render(size, { rounded }) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const SS = 4, k = 512 / size;
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let cover = 0, glyph = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) * k, y = (py + (sy + 0.5) / SS) * k;
        if (!rounded || inRoundRect(x, y, 112)) { cover++; if (inGlyph(x, y)) glyph++; }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const g = cover ? glyph / cover : 0;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(ORANGE[c] * (1 - g) + INK[c] * g);
      raw[o + 3] = Math.round((cover / (SS * SS)) * 255);
    }
  }
  return png(size, raw);
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#ea580c"/><g fill="none" stroke="#1a0d03" stroke-width="${W}"><path d="M${256 + R * Math.cos((-40 * Math.PI) / 180)} ${256 + R * Math.sin((-40 * Math.PI) / 180)}A${R} ${R} 0 1 0 ${256 + R} 256"/><path d="M256 256H${256 + R + W / 2}"/></g></svg>\n`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'icon-192.png'), render(192, { rounded: true }));
writeFileSync(join(OUT, 'icon-512.png'), render(512, { rounded: true }));
writeFileSync(join(OUT, 'icon-maskable-512.png'), render(512, { rounded: false }));
writeFileSync(join(OUT, 'apple-touch-icon.png'), render(180, { rounded: false })); // iOS rounds it itself
writeFileSync(join(OUT, 'icon.svg'), svg);
console.log('wrote icons to', OUT);
