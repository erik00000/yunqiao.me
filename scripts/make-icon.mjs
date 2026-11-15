// 生成应用图标（纯 Node，无依赖）：极光渐变圆角方块 + 中心光点
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const SIZE = 512;

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function buildPNG(size, pixelFn) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 圆角矩形 + 极光渐变
function iconPixel(x, y, size) {
  const cx = size / 2;
  const cy = size / 2;
  const pad = size * 0.055;
  const r = size * 0.24;
  const rx = size / 2 - pad;
  const dx = Math.abs(x - cx) - (rx - r);
  const dy = Math.abs(y - cy) - (rx - r);
  const dist =
    Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2) + Math.min(Math.max(dx, dy), 0) - r;
  const inside = dist < 0;
  const alpha = inside ? 255 : dist < 1.5 ? Math.round(255 * (1 - dist / 1.5)) : 0;
  if (alpha === 0) return [0, 0, 0, 0];

  // 极光渐变：斜向多色
  const t = (x / size) * 0.55 + (y / size) * 0.45;
  const stops = [
    [109, 140, 255],
    [139, 92, 246],
    [34, 211, 238],
    [109, 140, 255],
  ];
  const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
  const lt = t * (stops.length - 1) - seg;
  let R = lerp(stops[seg][0], stops[seg + 1][0], lt);
  let G = lerp(stops[seg][1], stops[seg + 1][1], lt);
  let B = lerp(stops[seg][2], stops[seg + 1][2], lt);

  // 中心光晕（"极光"核心）
  const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / (size * 0.5);
  const glow = Math.max(0, 1 - d * 1.35) ** 2;
  R = Math.min(255, R + glow * 70);
  G = Math.min(255, G + glow * 70);
  B = Math.min(255, B + glow * 80);

  // 内圈深色镂空 + 中心亮点
  const innerR = size * 0.225;
  if (d * size * 0.5 < innerR) {
    const k = 1 - d * size * 0.5 / innerR;
    R = lerp(12, R, 0.25 + k * 0.4);
    G = lerp(14, G, 0.25 + k * 0.4);
    B = lerp(20, B, 0.25 + k * 0.4);
  }
  return [Math.round(R), Math.round(G), Math.round(B), alpha];
}

const outDir = path.resolve(process.argv[2] ?? 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), buildPNG(SIZE, iconPixel));
const uiDir = path.resolve(path.dirname(outDir), 'ui', 'public');
fs.mkdirSync(uiDir, { recursive: true });
fs.writeFileSync(path.join(uiDir, 'tray.png'), buildPNG(32, iconPixel));
// Transparent monochrome route glyph; macOS colors template images for the menu bar.
function templatePixel(x, y, size) {
  const px = (x + .5) / size * 24, py = (y + .5) / size * 24;
  const segments = [[5, 6, 12, 6], [12, 6, 12, 18], [12, 18, 19, 18]];
  const distances = segments.map(([x1, y1, x2, y2]) => {
    const t = Math.max(0, Math.min(1, ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / ((x2 - x1) ** 2 + (y2 - y1) ** 2)));
    return Math.hypot(px - x1 - t * (x2 - x1), py - y1 - t * (y2 - y1)) - 1.15;
  });
  distances.push(Math.hypot(px - 5, py - 6) - 2.6, Math.hypot(px - 19, py - 18) - 2.6);
  return [0, 0, 0, Math.round(Math.max(0, Math.min(1, .5 - Math.min(...distances) * size / 24)) * 255)];
}
fs.writeFileSync(path.join(uiDir, 'trayTemplate.png'), buildPNG(18, templatePixel));
fs.writeFileSync(path.join(uiDir, 'trayTemplate@2x.png'), buildPNG(36, templatePixel));
console.log('应用图标与 Windows / macOS 托盘图标已生成');
