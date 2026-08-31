/**
 * Generates the PWA icons in /public from scratch.
 *
 * Run with:  npm run icons
 *
 * This writes real PNG files using only Node's built-in zlib, so there is no
 * image library to install. Swap in your own artwork whenever you like -- the
 * app only cares that the filenames in manifest.webmanifest exist.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

/* -- Minimal PNG encoder --------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/** rgba: a Buffer of width * height * 4 bytes. */
function encodePng(width, height, rgba) {
  // PNG stores each row prefixed by a filter byte; 0 means "no filter".
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* -- The artwork ----------------------------------------------------------- */

// Two beamed eighth notes, drawn in a 0..1 coordinate space so the same
// geometry works at any size. y increases downwards.
const NOTE = {
  beam: { x0: 0.3, x1: 0.7, y0: 0.16, y1: 0.28 },
  stemLeft: { x0: 0.3, x1: 0.355, y0: 0.16, y1: 0.68 },
  stemRight: { x0: 0.645, x1: 0.7, y0: 0.16, y1: 0.6 },
  headLeft: { cx: 0.245, cy: 0.7, rx: 0.115, ry: 0.085 },
  headRight: { cx: 0.59, cy: 0.62, rx: 0.115, ry: 0.085 },
}

const inRect = (x, y, r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1

const inEllipse = (x, y, e) => {
  const dx = (x - e.cx) / e.rx
  const dy = (y - e.cy) / e.ry
  return dx * dx + dy * dy <= 1
}

/**
 * @param size    pixel width/height of the square icon
 * @param inset   how much to shrink the note towards the centre. Maskable
 *                icons get a bigger inset so nothing important is cropped by
 *                Android's circle / squircle masks.
 */
function drawIcon(size, inset) {
  const rgba = Buffer.alloc(size * size * 4)

  // Anti-aliasing by supersampling: sample each pixel on a 3x3 grid and
  // average, which keeps the curved note heads smooth.
  const SAMPLES = 3

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let coverage = 0

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          // Position within the icon, 0..1
          const u = (px + (sx + 0.5) / SAMPLES) / size
          const v = (py + (sy + 0.5) / SAMPLES) / size
          // Position within the note's own (shrunken) box
          const x = (u - 0.5) / inset + 0.5
          const y = (v - 0.5) / inset + 0.5

          if (
            inRect(x, y, NOTE.beam) ||
            inRect(x, y, NOTE.stemLeft) ||
            inRect(x, y, NOTE.stemRight) ||
            inEllipse(x, y, NOTE.headLeft) ||
            inEllipse(x, y, NOTE.headRight)
          ) {
            coverage++
          }
        }
      }

      coverage /= SAMPLES * SAMPLES

      // Vertical gradient background: violet at the top, indigo at the bottom.
      const t = py / (size - 1)
      const bgR = Math.round(124 + (67 - 124) * t)
      const bgG = Math.round(92 + (56 - 92) * t)
      const bgB = Math.round(255 + (202 - 255) * t)

      // Blend the white note over the background by its coverage.
      const i = (py * size + px) * 4
      rgba[i] = Math.round(bgR + (255 - bgR) * coverage)
      rgba[i + 1] = Math.round(bgG + (255 - bgG) * coverage)
      rgba[i + 2] = Math.round(bgB + (255 - bgB) * coverage)
      rgba[i + 3] = 255
    }
  }

  return encodePng(size, size, rgba)
}

/* -- Write the files ------------------------------------------------------- */

mkdirSync(PUBLIC_DIR, { recursive: true })

const outputs = [
  ['icon-192.png', 192, 0.78],
  ['icon-512.png', 512, 0.78],
  // Maskable: extra padding so the note survives an aggressive crop.
  ['icon-512-maskable.png', 512, 0.58],
  ['apple-touch-icon.png', 180, 0.78],
]

for (const [name, size, inset] of outputs) {
  const png = drawIcon(size, inset)
  writeFileSync(join(PUBLIC_DIR, name), png)
  console.log(`wrote public/${name} (${size}x${size}, ${png.length} bytes)`)
}

// A crisp vector favicon for browser tabs, using the same geometry.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7c5cff"/>
      <stop offset="1" stop-color="#4338ca"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="22" fill="url(#g)"/>
  <g fill="#fff" transform="translate(50 50) scale(0.78) translate(-50 -50)">
    <rect x="30" y="16" width="40" height="12"/>
    <rect x="30" y="16" width="5.5" height="52"/>
    <rect x="64.5" y="16" width="5.5" height="44"/>
    <ellipse cx="24.5" cy="70" rx="11.5" ry="8.5"/>
    <ellipse cx="59" cy="62" rx="11.5" ry="8.5"/>
  </g>
</svg>
`
writeFileSync(join(PUBLIC_DIR, 'favicon.svg'), favicon)
console.log('wrote public/favicon.svg')
