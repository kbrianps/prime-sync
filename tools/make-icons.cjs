/*
 * Gera os ícones da extensão (PNG RGBA) sem dependências.
 * Uso: node tools/make-icons.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'extension', 'icons');
const SIZES = [16, 32, 48, 128];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function png(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filtro "none"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

const BG_TOP = [17, 26, 38];
const BG_BOTTOM = [8, 12, 18];
const LEFT = [76, 194, 255];
const RIGHT = [47, 209, 139];

function lemniscate(size) {
  const a = size * 0.37;
  const cx = size / 2;
  const cy = size / 2;
  const points = [];
  const steps = 720;
  for (let k = 0; k <= steps; k += 1) {
    const t = (k / steps) * Math.PI * 2;
    const s = Math.sin(t);
    const d = 1 + s * s;
    points.push({ x: cx + (a * Math.cos(t)) / d, y: cy + (a * 1.45 * s * Math.cos(t)) / d, t });
  }
  return points;
}

function segmentDistance(px, py, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len = vx * vx + vy * vy;
  const u = len ? Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / len)) : 0;
  const dx = px - (a.x + vx * u);
  const dy = py - (a.y + vy * u);
  return Math.sqrt(dx * dx + dy * dy);
}

function distances(px, py, points) {
  let over = Infinity;
  let under = Infinity;
  for (let k = 1; k < points.length; k += 1) {
    const d = segmentDistance(px, py, points[k - 1], points[k]);
    const t = points[k].t;
    if (t > Math.PI * 0.3 && t < Math.PI * 0.7) over = Math.min(over, d);
    else under = Math.min(under, d);
  }
  return { over, under };
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.24;
  const stroke = Math.max(size * 0.1, 1.9);
  const gap = size >= 32 ? size * 0.05 : 0;
  const samples = size <= 32 ? 6 : 4;
  const points = lemniscate(size);
  const left = size * 0.13;
  const span = size * 0.74;

  const insideRoundRect = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          if (!insideRoundRect(px, py)) continue;

          const v = py / size;
          let color = [
            mix(BG_TOP[0], BG_BOTTOM[0], v),
            mix(BG_TOP[1], BG_BOTTOM[1], v),
            mix(BG_TOP[2], BG_BOTTOM[2], v),
          ];

          const { over, under } = distances(px, py, points);
          const h = Math.max(0, Math.min(1, (px - left) / span));
          const ink = [mix(LEFT[0], RIGHT[0], h), mix(LEFT[1], RIGHT[1], h), mix(LEFT[2], RIGHT[2], h)];

          if (over <= stroke / 2) color = ink;
          else if (over <= stroke / 2 + gap) color = color;
          else if (under <= stroke / 2) color = ink;

          r += color[0];
          g += color[1];
          b += color[2];
          alpha += 1;
        }
      }

      const i = (y * size + x) * 4;
      if (alpha) {
        pixels[i] = Math.round(r / alpha);
        pixels[i + 1] = Math.round(g / alpha);
        pixels[i + 2] = Math.round(b / alpha);
      }
      pixels[i + 3] = Math.round((alpha / (samples * samples)) * 255);
    }
  }

  return png(size, size, pixels);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log('gerado', file);
}
