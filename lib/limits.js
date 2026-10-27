/**
 * Admission-limit resolution and geometry helpers.
 *
 * Limits are always read from the live attachment store at call time — never
 * captured at activation and never hard-coded — so a profile that configures
 * `maxImageDimension: 2000` (or any other value) is repaired to *those* limits.
 * The `config` values exist only as explicit test/deployment overrides.
 */
import { DEFAULT_LIMITS, positiveInteger } from './config.js'
import { DEFAULT_MEDIA_TYPES } from './mime.js'

/**
 * Resolve the effective admission limits for one call.
 *
 * @param {object | null | undefined} store live `ctx.attachments` instance.
 * @param {Record<string, unknown>} config resolved plugin config.
 * @returns {{ maxImageBytes: number, maxImagePixels: number, maxImageDimension: number, maxMessageImageBytes: number, mediaTypes: readonly string[] }} effective limits.
 */
export function readLimits(store, config) {
  const live = store?.imageLimits ?? {}
  return {
    maxImageBytes: positiveInteger(config?.maxImageBytes) ?? positiveInteger(live.maxImageBytes) ?? DEFAULT_LIMITS.maxImageBytes,
    maxImagePixels: positiveInteger(config?.maxImagePixels) ?? positiveInteger(live.maxImagePixels) ?? DEFAULT_LIMITS.maxImagePixels,
    maxImageDimension: positiveInteger(config?.maxImageDimension) ?? positiveInteger(live.maxImageDimension) ?? DEFAULT_LIMITS.maxImageDimension,
    maxMessageImageBytes:
      positiveInteger(config?.maxMessageImageBytes) ?? positiveInteger(live.maxMessageImageBytes) ?? DEFAULT_LIMITS.maxMessageImageBytes,
    mediaTypes:
      Array.isArray(live.mediaTypes) && live.mediaTypes.length > 0
        ? Object.freeze([...live.mediaTypes])
        : DEFAULT_MEDIA_TYPES,
  }
}

/**
 * Aspect-preserving integer dimensions under a total-pixel budget, then under a
 * long-edge cap — the same order the store uses, so a repaired source is not
 * shrunk further than necessary by `normalizeImage` later.
 *
 * @param {number} width source width (already orientation-applied).
 * @param {number} height source height.
 * @param {{ maxImagePixels: number, maxImageDimension: number }} limits effective limits.
 * @returns {{ width: number, height: number }} target dimensions; never enlarged.
 */
export function targetDimensions(width, height, limits) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { width: 1, height: 1 }
  let w = Math.floor(width)
  let h = Math.floor(height)

  const pixels = w * h
  if (pixels > limits.maxImagePixels) {
    const scale = Math.sqrt(limits.maxImagePixels / pixels)
    w = Math.max(1, Math.floor(w * scale))
    h = Math.max(1, Math.floor(h * scale))
    // Integer rounding can leave a single pixel over budget; walk it down.
    while (w * h > limits.maxImagePixels && w > 1 && h > 1) {
      if (w >= h) w -= 1
      else h -= 1
    }
  }

  const longEdge = Math.max(w, h)
  if (longEdge > limits.maxImageDimension) {
    const scale = limits.maxImageDimension / longEdge
    w = Math.max(1, Math.floor(w * scale))
    h = Math.max(1, Math.floor(h * scale))
  }

  return { width: w, height: h }
}

/**
 * Scale one dimension pair down by a fixed factor, never below one pixel.
 *
 * @param {{ width: number, height: number }} dims current dimensions.
 * @param {number} factor multiplier in (0, 1).
 * @returns {{ width: number, height: number }} smaller dimensions.
 */
export function shrinkDimensions(dims, factor) {
  return {
    width: Math.max(1, Math.floor(dims.width * factor)),
    height: Math.max(1, Math.floor(dims.height * factor)),
  }
}

/**
 * Whether an encoded result — not its source — satisfies every admission limit.
 *
 * @param {number} width encoded width.
 * @param {number} height encoded height.
 * @param {number} bytes encoded byte length.
 * @param {{ maxImageBytes: number, maxImagePixels: number, maxImageDimension: number }} limits effective limits.
 * @returns {boolean} true when admission will accept the result.
 */
export function fitsLimits(width, height, bytes, limits) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false
  if (!Number.isFinite(bytes) || bytes <= 0) return false
  if (bytes > limits.maxImageBytes) return false
  if (width * height > limits.maxImagePixels) return false
  if (Math.max(width, height) > limits.maxImageDimension) return false
  return true
}

/**
 * Describe which admission limits a source violates, for logging and control flow.
 *
 * @param {{ width: number, height: number }} dims orientation-applied source dimensions.
 * @param {number} bytes source byte length.
 * @param {{ maxImageBytes: number, maxImagePixels: number, maxImageDimension: number }} limits effective limits.
 * @returns {string[]} violation labels, empty when the source already fits.
 */
export function violationsFor(dims, bytes, limits) {
  const violations = []
  if (bytes > limits.maxImageBytes) violations.push('bytes')
  if (dims.width * dims.height > limits.maxImagePixels) violations.push('pixels')
  if (Math.max(dims.width, dims.height) > limits.maxImageDimension) violations.push('dimension')
  return violations
}

/**
 * Apply EXIF orientation to width/height, mirroring the store's own accounting.
 *
 * @param {number} width raw width.
 * @param {number} height raw height.
 * @param {number | undefined} orientation EXIF orientation, 1..8.
 * @returns {{ width: number, height: number }} orientation-applied dimensions.
 */
export function orientDimensions(width, height, orientation) {
  return typeof orientation === 'number' && orientation >= 5 ? { width: height, height: width } : { width, height }
}
