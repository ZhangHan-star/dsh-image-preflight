/**
 * Declared-media-type normalisation and format → media-type mapping.
 *
 * Browsers derive `file.type` from the file extension, so a JPEG saved as
 * `photo.png` arrives declared as `image/png`. The Host then decodes the bytes,
 * sees `jpeg`, and rejects the upload with IMAGE_TYPE_MISMATCH — even though
 * the file is a perfectly good picture. This module is the lookup table used to
 * relabel such sources without touching a single byte.
 */

/** The four media types DSH admits by default. */
export const DEFAULT_MEDIA_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

/** Non-standard spellings browsers and OSes emit for the same container. */
const MIME_ALIASES = new Map([
  ['image/jpg', 'image/jpeg'],
  ['image/jpe', 'image/jpeg'],
  ['image/jfif', 'image/jpeg'],
  ['image/pjpeg', 'image/jpeg'],
  ['image/x-jpeg', 'image/jpeg'],
  ['image/x-png', 'image/png'],
  ['image/x-webp', 'image/webp'],
  ['image/x-gif', 'image/gif'],
  ['image/x-icon', 'image/x-icon'],
])

/** sharp's `metadata().format` value → the media type DSH admits. */
const FORMAT_MEDIA_TYPES = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
})

/**
 * Formats this desktop build of sharp/libvips decodes but DSH does not admit
 * as-is — the plugin can transcode these.
 */
export const DECODABLE_UNSUPPORTED_FORMATS = Object.freeze(['avif', 'heif', 'tiff', 'svg'])

/**
 * Formats the bundled libvips cannot decode at all (no ImageMagick backend), so
 * they keep their original `INVALID_IMAGE` — documented, not repaired.
 */
export const UNDECODABLE_FORMATS = Object.freeze(['bmp', 'ico', 'jxl', 'jp2', 'pdf'])

/**
 * Normalise one declared media type: lowercase, strip parameters, resolve
 * known aliases. Unknown values are returned lowercased and unchanged so the
 * caller can decide whether the bytes tell a better story.
 *
 * @param {unknown} value raw `input.mediaType`.
 * @returns {{ mediaType: string, aliased: boolean }} the usable declaration and
 *   whether an alias was rewritten.
 */
export function normalizeDeclaredMediaType(value) {
  if (typeof value !== 'string') return { mediaType: '', aliased: false }
  const base = value.split(';')[0].trim().toLowerCase()
  if (base === '') return { mediaType: '', aliased: false }
  const alias = MIME_ALIASES.get(base)
  if (alias !== undefined && alias !== base) return { mediaType: alias, aliased: true }
  return { mediaType: base, aliased: false }
}

/**
 * Map one decoded container format to the media type DSH admits.
 *
 * @param {string | undefined} format sharp's `metadata().format`.
 * @returns {string | null} the admitting media type, or null when unsupported.
 */
export function mediaTypeForFormat(format) {
  if (typeof format !== 'string') return null
  return FORMAT_MEDIA_TYPES[format] ?? null
}

/**
 * Whether one media type belongs to the deployment admission whitelist.
 *
 * @param {string} mediaType candidate media type.
 * @param {readonly string[]} allowed deployment whitelist.
 * @returns {boolean} admission eligibility.
 */
export function isAdmittedMediaType(mediaType, allowed) {
  return typeof mediaType === 'string' && mediaType !== '' && allowed.includes(mediaType)
}
