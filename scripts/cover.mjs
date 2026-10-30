// Generates cover.png (800x534) for gladys-usgs-eau: plain Node, no
// dependency. A river between two banks, a gauge staff with its marks and the
// water level, a hydrograph curve and a well reaching the groundwater, on a
// gradient (no logo of the agency). Drawing helpers taken from gladys-droplet
// (same author).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
const skyAt = (x, y) => {
  const t = (x / W) * 0.7 + (y / H) * 0.3;
  return [40 + 30 * t, 120 + 50 * t, 200 - 40 * t];
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    set(x, y, skyAt(x, y));
  }
}
const white = [255, 255, 255];
const dark = [28, 38, 64];
const green = [90, 210, 130];
const red = [220, 60, 60];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a);
    }
  }
};

disc(400, 270, 260, white, 0.05);
const water = [40, 110, 200];
const deep = [24, 70, 150];
const bank = [120, 170, 90];
const soil = [150, 115, 80];
const orange = [250, 170, 70];

// The banks and the river.
box(0, 300, 800, 534, 0, bank);
box(0, 340, 800, 534, 0, soil);
box(0, 300, 560, 420, 0, water);
for (let x = 0; x < 560; x += 6) {
  const y = 300 + 6 * Math.sin(x / 30);
  line(x, y, x + 6, 300 + 6 * Math.sin((x + 6) / 30), 6, deep);
}
for (let k = 0; k < 4; k += 1) {
  for (let x = 30 + k * 40; x < 520; x += 120) {
    line(x, 340 + k * 18, x + 40, 340 + k * 18, 4, white);
  }
}

// The gauge staff, its marks, the level.
box(440, 150, 470, 420, 4, white);
for (let y = 160; y < 420; y += 20) line(446, y, y % 40 === 0 ? 466 : 458, y, 4, dark);
line(420, 300, 490, 300, 6, orange);

// The groundwater well: a casing down to the water table.
box(640, 250, 670, 470, 3, white);
box(646, 260, 664, 470, 2, dark);
box(646, 420, 664, 470, 0, water);
line(590, 420, 760, 420, 4, water);
for (let x = 590; x < 760; x += 24) line(x, 440, x + 12, 440, 3, water);

// The hydrograph: discharge rising then falling.
box(60, 50, 380, 240, 16, white, 0.92);
line(80, 220, 360, 220, 4, dark);
line(80, 220, 80, 70, 4, dark);
let prev;
for (let x = 90; x <= 350; x += 4) {
  const y = 205 - 120 * Math.exp(-(((x - 210) / 55) ** 2));
  if (prev) line(prev[0], prev[1], x, y, 6, water);
  prev = [x, y];
}
line(90, 125, 350, 125, 3, red);
disc(210, 85, 9, green);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
