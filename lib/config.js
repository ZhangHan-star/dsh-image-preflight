/**
 * Configuration defaults and validation.
 *
 * The plugin deliberately exports no Cordis `Config` schema: a profile-installed
 * bundle must stay dependency-free (no `@deepseek-ai/schemastery` import), and an
 * absent schema simply means the Loader hands the raw row config through. Every
 * value is therefore validated here, defensively, on activation.
 */

/** Fallback limits used only when a store exposes no `imageLimits` at all. */
export const DEFAULT_LIMITS = Object.freeze({
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 200 * 1024 * 1024,
  maxImagePixels: 64_000_000,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
})

/** Hard cap so a hostile config cannot pin the decoder queue. */
export const MAX_QUALITY_LADDER = 8

export const DEFAULT_CONFIG = Object.freeze({
  /** Master switch; `false` makes the plugin a no-op (no wrapping at all). */
  enabled: true,
  /** Explicit overrides; `undefined` means "read the live attachment store". */
  maxImageBytes: undefined,
  maxImagePixels: undefined,
  maxImageDimension: undefined,
  maxMessageImageBytes: undefined,
  /** `auto` keeps alpha images as WebP and everything else as JPEG. */
  targetFormat: 'auto',
  /** Prefer a lossless target (PNG for opaque sources) over JPEG. */
  preferLossless: false,
  /** Background colour used when an alpha image must become JPEG. */
  alphaBackground: '#ffffff',
  /** Same-format quality ladder, highest first. */
  qualityLadder: Object.freeze([85, 75, 65, 55, 45]),
  /** Multi-frame policy: shrink (keep frames), first-frame, or passthrough. */
  animated: 'shrink',
  /** Concurrent native transforms; 1..8, aligned with the store's own limiter. */
  concurrency: 2,
  /** Decode even when the header probe fails, hoping for a partial raster. */
  tryPartialDecode: false,
  /** Refuse to decode anything above this pixel count (OOM guard). */
  maxDecodePixels: 300_000_000,
  /** Per-image transform budget; on expiry the source passes through. */
  transformTimeoutMs: 30_000,
  /** silent | info | debug */
  logLevel: 'info',
})

const TARGET_FORMATS = new Set(['auto', 'jpeg', 'webp', 'png'])
const ANIMATED_MODES = new Set(['shrink', 'first-frame', 'passthrough'])
const LOG_LEVELS = new Set(['silent', 'info', 'debug'])
const HEX_COLOUR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * @param {unknown} value candidate number.
 * @returns {number | undefined} a positive safe integer, or undefined.
 */
export function positiveInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Validate a raw Loader row config and merge it over the defaults.
 * Unknown keys are dropped; invalid values fall back to the default.
 *
 * @param {Record<string, unknown> | undefined} raw config from the Loader row.
 * @returns {typeof DEFAULT_CONFIG & Record<string, unknown>} resolved config.
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const config = { ...DEFAULT_CONFIG }

  if (typeof input.enabled === 'boolean') config.enabled = input.enabled

  for (const key of ['maxImageBytes', 'maxImagePixels', 'maxImageDimension', 'maxMessageImageBytes', 'maxDecodePixels', 'transformTimeoutMs']) {
    const value = positiveInteger(input[key])
    if (value !== undefined) config[key] = value
  }

  if (typeof input.targetFormat === 'string' && TARGET_FORMATS.has(input.targetFormat)) config.targetFormat = input.targetFormat
  if (typeof input.preferLossless === 'boolean') config.preferLossless = input.preferLossless
  if (typeof input.alphaBackground === 'string' && HEX_COLOUR.test(input.alphaBackground.trim())) {
    config.alphaBackground = input.alphaBackground.trim()
  }

  const ladder = Array.isArray(input.qualityLadder)
    ? input.qualityLadder
        .filter((value) => typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 100)
        .map((value) => Math.round(value))
    : []
  if (ladder.length > 0) config.qualityLadder = Object.freeze([...new Set(ladder)].slice(0, MAX_QUALITY_LADDER))

  if (typeof input.animated === 'string' && ANIMATED_MODES.has(input.animated)) config.animated = input.animated
  const concurrency = positiveInteger(input.concurrency)
  if (concurrency !== undefined) config.concurrency = Math.min(8, concurrency)
  if (typeof input.tryPartialDecode === 'boolean') config.tryPartialDecode = input.tryPartialDecode
  if (typeof input.logLevel === 'string' && LOG_LEVELS.has(input.logLevel)) config.logLevel = input.logLevel

  return config
}
