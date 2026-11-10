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

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.23;

  const insideRoundRect = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  const x0 = size * 0.36;
  const x1 = size * 0.72;
  const cy = size * 0.5;
  const half = size * 0.2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;

      if (!insideRoundRect(px, py)) {
        pixels[i + 3] = 0;
        continue;
      }

      // fundo com leve gradiente diagonal
      const t = (px + py) / (size * 2);
      pixels[i] = Math.round(mix(14, 26, t));
      pixels[i + 1] = Math.round(mix(17, 32, t));
      pixels[i + 2] = Math.round(mix(22, 40, t));
      pixels[i + 3] = 255;

      // triângulo de play
      if (px >= x0 && px <= x1) {
        const maxHalf = ((px - x0) / (x1 - x0)) * half;
        if (Math.abs(py - cy) <= maxHalf) {
          pixels[i] = 38;
          pixels[i + 1] = 194;
          pixels[i + 2] = 129;
        }
      }
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
