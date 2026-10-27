/**
 * Test fixtures, generated at run time with sharp — no binary files live in the
 * repository. `simulateAdmission` mirrors `@deepseek-ai/dsh-attachment-local`'s
 * `validateImageBatch` + `inspectMetadata` so a test can prove that an input
 * still fails upstream exactly as before the plugin was installed.
 */
import { loadSharp } from '../lib/sharp.js'

export { loadSharp }

export const DEFAULT_TEST_LIMITS = Object.freeze({
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxImagePixels: 64_000_000,
  maxImageDimension: 8192,
  maxMessageImageBytes: 200 * 1024 * 1024,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
})

const FORMAT_TO_MEDIA = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

/**
 * Deterministic pseudo-random bytes, so encoded fixtures are reproducible.
 *
 * @param {number} width pixels.
 * @param {number} height pixels.
 * @param {number} channels 3 or 4.
 * @returns {Buffer} raw pixel buffer.
 */
export function noise(width, height, channels = 3) {
  const buffer = Buffer.alloc(width * height * channels)
  let state = 0x12345678
  for (let index = 0; index < buffer.length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff
    buffer[index] = (state >>> 15) & 0xff
  }
  if (channels === 4) {
    for (let index = 3; index < buffer.length; index += 4) buffer[index] = 128 + (index % 127)
  }
  return buffer
}

/**
 * @param {Function} sharp callable sharp.
 * @param {number} width pixels.
 * @param {number} height pixels.
 * @param {'png'|'jpeg'|'webp'|'tiff'|'gif'|'avif'} format output container.
 * @param {number} channels 3 or 4.
 * @returns {Promise<Uint8Array>} encoded bytes.
 */
export async function makeImage(sharp, width, height, format = 'png', channels = 3) {
  const raw = noise(width, height, channels)
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels } }).toFormat(format).toBuffer())
}

/**
 * A 2x2, two-frame GIF89a with two distinct colours. Hand-assembled because
 * sharp cannot author multi-frame images from raw input.
 *
 * @returns {Uint8Array} animated GIF bytes.
 */
export function animatedGif() {
  return Uint8Array.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
    0x02, 0x00, 0x02, 0x00, // logical screen 2x2
    0xf0, 0x00, 0x00, // global colour table, 2 entries
    0xff, 0x00, 0x00, 0x00, 0x00, 0xff, // red, blue
    0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00,
    // frame 1 — colour index 0
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
    // frame 2 — colour index 1
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x00,
    0x02, 0x02, 0x4c, 0x01, 0x00,
    0x3b, // trailer
  ])
}

/**
 * Bytes that carry a PNG signature but no decodable image.
 *
 * @returns {Uint8Array} corrupt PNG bytes.
 */
export function corruptPng() {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let index = 8; index < bytes.length; index += 1) bytes[index] = (index * 37) & 0xff
  return bytes
}

/**
 * @param {Function} sharp callable sharp.
 * @param {Uint8Array} data encoded bytes.
 * @returns {Promise<{ format?: string, width: number, height: number, pages: number, hasAlpha: boolean }>} decoded facts.
 */
export async function factsOf(sharp, data) {
  const meta = await sharp(data, { failOn: 'none', limitInputPixels: false }).metadata()
  return {
    format: meta.format,
    width: meta.width,
    height: meta.height,
    pages: meta.pages ?? 1,
    hasAlpha: meta.hasAlpha === true,
  }
}

/**
 * A logger that records instead of printing.
 *
 * @returns {{ info: Function, warn: Function, debug: Function, lines: string[] }} recording logger.
 */
export function recordingLogger() {
  const lines = []
  return {
    lines,
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
    debug: (message) => lines.push(`debug ${message}`),
  }
}

/**
 * Mirror the upstream admission checks in the same order as
 * `LocalAttachmentStore.saveImages` → `prepareImageFile` → `inspectMetadata`,
 * so tests can assert "still refused with the same code".
 *
 * @param {Function} sharp callable sharp.
 * @param {{ data: Uint8Array, mediaType?: string }} input one attachment input.
 * @param {typeof DEFAULT_TEST_LIMITS} limits admission limits.
 * @returns {Promise<void>} resolves when admission would accept the input.
 * @throws {Error} an error carrying the upstream `code`.
 */
export async function simulateAdmission(sharp, input, limits) {
  const fail = (code) => {
    const error = new Error(code)
    error.code = code
    throw error
  }
  // `inspectMetadata` rejects an empty payload before touching the decoder.
  if (!(input.data instanceof Uint8Array) || input.data.byteLength === 0) fail('INVALID_IMAGE')
  if (!Array.isArray(limits.mediaTypes) || !limits.mediaTypes.includes(input.mediaType)) fail('UNSUPPORTED_IMAGE_TYPE')
  if (input.data.byteLength > limits.maxImageBytes) fail('IMAGE_TOO_LARGE')

  let meta
  let image
  try {
    image = sharp(input.data, { failOn: 'error', limitInputPixels: false })
    meta = await image.metadata()
  } catch {
    fail('INVALID_IMAGE')
  }
  const detected = FORMAT_TO_MEDIA[meta.format]
  if (detected === undefined) fail('INVALID_IMAGE')
  const transposed = typeof meta.orientation === 'number' && meta.orientation >= 5
  const width = transposed ? meta.height : meta.width
  const height = transposed ? meta.width : meta.height
  if (width * height > limits.maxImagePixels) fail('IMAGE_TOO_MANY_PIXELS')
  if (Math.max(width, height) > limits.maxImageDimension) fail('IMAGE_DIMENSION_TOO_LARGE')
  try {
    await image.raw().toBuffer()
  } catch {
    fail('INVALID_IMAGE')
  }
  if (detected !== input.mediaType) fail('IMAGE_TYPE_MISMATCH')
}
