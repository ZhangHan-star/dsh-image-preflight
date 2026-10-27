/**
 * Hand-rolled encoders for fixtures sharp cannot author itself:
 * 16-bit PNG, 24-bit BMP, 2-frame GIF89a, SVG, plus small byte helpers.
 * Everything is deterministic and dependency-free.
 */
import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/**
 * @param {Uint8Array} bytes input.
 * @returns {number} CRC-32 as an unsigned integer.
 */
export function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * @param {string} type four-character chunk type.
 * @param {Uint8Array} data chunk payload.
 * @returns {Buffer} one PNG chunk with length, type, payload and CRC.
 */
function pngChunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/**
 * Encode an uncompressed-filter RGB PNG at 16 bits per channel — the classic
 * "deep colour" source that DSH normalises down to 8-bit sRGB.
 *
 * @param {number} width pixels.
 * @param {number} height pixels.
 * @returns {Buffer} PNG bytes.
 */
export function encodePng16(width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 16 // bit depth
  header[9] = 2 // colour type: truecolour
  header[10] = 0
  header[11] = 0
  header[12] = 0

  const stride = 1 + width * 6
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * stride
    raw[row] = 0
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 6
      const r = Math.round((x / width) * 65535)
      const g = Math.round((y / height) * 65535)
      const b = Math.round(((x + y) / (width + height)) * 65535)
      raw.writeUInt16BE(r, offset)
      raw.writeUInt16BE(g, offset + 2)
      raw.writeUInt16BE(b, offset + 4)
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Encode a 24-bit uncompressed BMP (bottom-up rows, 4-byte padded).
 *
 * @param {number} width pixels.
 * @param {number} height pixels.
 * @returns {Buffer} BMP bytes.
 */
export function encodeBmp24(width, height) {
  const rowBytes = Math.ceil((width * 3) / 4) * 4
  const pixelBytes = rowBytes * height
  const file = Buffer.alloc(54 + pixelBytes)
  file.write('BM', 0, 'ascii')
  file.writeUInt32LE(54 + pixelBytes, 2)
  file.writeUInt32LE(54, 10)
  file.writeUInt32LE(40, 14)
  file.writeInt32LE(width, 18)
  file.writeInt32LE(height, 22)
  file.writeUInt16LE(1, 26)
  file.writeUInt16LE(24, 28)
  file.writeUInt32LE(pixelBytes, 34)
  file.writeInt32LE(2835, 38)
  file.writeInt32LE(2835, 42)

  for (let y = 0; y < height; y += 1) {
    const target = 54 + (height - 1 - y) * rowBytes
    for (let x = 0; x < width; x += 1) {
      const offset = target + x * 3
      file[offset] = (x * 7 + y * 3) & 0xff
      file[offset + 1] = (y * 5) & 0xff
      file[offset + 2] = (x * 11) & 0xff
    }
  }
  return file
}

/**
 * A 2x2 GIF89a with two visually different frames (red -> blue).
 *
 * @returns {Buffer} animated GIF bytes.
 */
export function encodeAnimatedGif() {
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
    0x02, 0x00, 0x02, 0x00, // logical screen 2x2
    0xf0, 0x00, 0x00, // global colour table, 2 entries
    0xff, 0x00, 0x00, 0x00, 0x00, 0xff, // red, blue
    0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00,
    // frame 1 — colour index 0 (red)
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
    // frame 2 — colour index 1 (blue)
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00,
    0x02, 0x02, 0x4c, 0x01, 0x00,
    0x3b, // trailer
  ])
}

/**
 * @returns {Buffer} an opaque SVG document.
 */
export function encodeSvg() {
  return Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">' +
      '<rect width="240" height="160" fill="#f0f4ff"/>' +
      '<circle cx="90" cy="80" r="46" fill="#1f6feb"/>' +
      '<rect x="130" y="46" width="86" height="68" rx="10" fill="#0b3f9e"/>' +
      '</svg>',
    'utf8',
  )
}
