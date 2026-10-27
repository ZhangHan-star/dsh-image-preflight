/**
 * The repair pipeline.
 *
 * Everything here is a pure function of its arguments plus the injected `sharp`
 * module and logger: no clock-dependent output, no randomness, no disk, no
 * network. `repairBatch` / `repairOne` are exported for unit tests.
 *
 * Processing order for one image (fixed, see README §能力矩阵):
 *   1. defensive pass-through for empty/non-byte inputs;
 *   2. declared media-type normalisation (aliases only, no bytes touched);
 *   3. cheap header probe — never a full pixel decode;
 *   4. mismatch between declared and real container → relabel only;
 *   5. unsupported-but-decodable container → transcode to an admitted type;
 *   6. byte/pixel/dimension overrun → transcode just far enough to fit;
 *   7. anything that cannot be repaired → the original input, untouched.
 */
import { fitsLimits, orientDimensions, readLimits, shrinkDimensions, targetDimensions, violationsFor } from './limits.js'
import { isAdmittedMediaType, mediaTypeForFormat, normalizeDeclaredMediaType } from './mime.js'

const JPEG = 'image/jpeg'
const WEBP = 'image/webp'
const PNG = 'image/png'

/** Maximum encoding attempts for one image across every round. */
const MAX_ENCODE_ATTEMPTS = 20
/** Maximum geometric shrink rounds after the first, full-quality pass. */
const MAX_SHRINK_ROUNDS = 4
/** Never shrink a repaired image below this longest edge. */
const MIN_LONG_EDGE = 32
/** Maximum images touched by the aggregate-byte pass, and its rounds. */
const MAX_BATCH_ATTEMPTS = 8
/** A single image is never re-encoded below this byte target by the batch pass. */
const MIN_BATCH_BYTES = 64 * 1024

/**
 * @param {unknown} input candidate attachment input.
 * @returns {boolean} whether this is a byte-carrying image input worth probing.
 */
export function isImageInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false
  const data = input.data
  if (data === null || typeof data !== 'object') return false
  const isBytes = data instanceof Uint8Array || Object.prototype.toString.call(data) === '[object Uint8Array]'
  return isBytes && typeof data.byteLength === 'number' && data.byteLength > 0
}

/**
 * Extract the facts this plugin needs from sharp metadata.
 *
 * @param {{ [key: string]: unknown }} meta sharp `metadata()` result.
 * @returns {{ format: string | undefined, width: number, height: number, pages: number, animated: boolean, hasAlpha: boolean, depth: unknown, space: unknown, orientation: number }} normalised facts.
 */
export function describeMetadata(meta) {
  const width = Math.trunc(Number(meta?.width))
  const height = Math.trunc(Number(meta?.height))
  const pages = Math.trunc(Number(meta?.pages))
  return {
    format: typeof meta?.format === 'string' ? meta.format : undefined,
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
    pages: Number.isFinite(pages) && pages > 0 ? pages : 1,
    animated: Number.isFinite(pages) && pages > 1,
    hasAlpha: meta?.hasAlpha === true,
    depth: meta?.depth,
    space: meta?.space,
    orientation: typeof meta?.orientation === 'number' ? meta.orientation : 1,
  }
}

/**
 * Pick the output container for one transcode.
 *
 * @param {ReturnType<typeof describeMetadata>} facts source facts.
 * @param {object} config resolved plugin config.
 * @returns {string} target media type.
 */
function pickTargetFormat(facts, config) {
  if (config.targetFormat !== 'auto') {
    return (config.targetFormat === 'jpeg' && JPEG) || (config.targetFormat === 'webp' && WEBP) || (config.targetFormat === 'png' && PNG) || JPEG
  }
  // Animation cannot survive JPEG; keep frames unless the caller asked for one.
  if (facts.animated && config.animated !== 'first-frame') return WEBP
  if (config.preferLossless) return facts.hasAlpha ? WEBP : PNG
  return facts.hasAlpha ? WEBP : JPEG
}

/**
 * Candidate containers in preference order: the chosen one, then WebP as the
 * universal lossy fallback (it preserves alpha and compresses better).
 *
 * @param {string} primary preferred target media type.
 * @returns {string[]} formats to try, highest preference first.
 */
function candidateFormats(primary) {
  return primary === WEBP ? [primary] : [primary, WEBP]
}

/**
 * Qualities to try for one format: lossy formats walk the ladder, lossless ones
 * encode once.
 *
 * @param {string} format target media type.
 * @param {readonly number[]} ladder configured quality ladder.
 * @returns {Array<number | undefined>} qualities, highest first.
 */
function qualitiesFor(format, ladder) {
  return format === PNG ? [undefined] : [...ladder]
}

/**
 * Encode one candidate from the source bytes.
 *
 * @param {Function} sharp callable sharp.
 * @param {Uint8Array} data source bytes.
 * @param {{ dims: { width: number, height: number }, format: string, quality: number | undefined, animated: boolean, hasAlpha: boolean, alphaBackground: string, source: { width: number, height: number } }} options encoding options.
 * @returns {Promise<{ data: Uint8Array, mediaType: string, width: number, height: number }>} encoded candidate.
 */
async function encodeCandidate(sharp, data, options) {
  const { dims, format, quality, animated, hasAlpha, alphaBackground, source } = options
  const constructorOptions = { failOn: 'error', limitInputPixels: false }
  if (animated) constructorOptions.animated = true

  let pipeline = sharp(data, constructorOptions)
  pipeline = pipeline.rotate()
  pipeline = pipeline.toColourspace('srgb')

  if (dims.width !== source.width || dims.height !== source.height) {
    pipeline = pipeline.resize({
      width: dims.width,
      height: dims.height,
      fit: 'inside',
      withoutEnlargement: true,
      kernel: 'lanczos3',
    })
  }

  if (format === JPEG) {
    if (hasAlpha) pipeline = pipeline.flatten({ background: alphaBackground })
    pipeline = pipeline.jpeg({ quality: quality ?? 82, mozjpeg: true })
  } else if (format === WEBP) {
    pipeline = pipeline.webp({ quality: quality ?? 82, effort: 0 })
  } else if (format === PNG) {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
  } else {
    throw new Error(`unsupported output format ${format}`)
  }

  const { data: buffer, info } = await pipeline.toBuffer({ resolveWithObject: true })
  // Animated output reports the stacked height with `pageHeight` per frame;
  // limits apply to one frame, never to the whole film-strip.
  const pages = Number(info.pages) > 0 ? Number(info.pages) : 1
  const pageHeight = Number(info.pageHeight) > 0 ? Number(info.pageHeight) : Math.max(1, Math.floor(info.height / pages))
  return {
    data: new Uint8Array(buffer),
    mediaType: format,
    width: info.width,
    height: pageHeight,
  }
}

/**
 * Encode the source until the result fits every limit, shrinking geometry only
 * after the quality ladder is exhausted.
 *
 * @param {object} args transcode arguments.
 * @returns {Promise<{ data: Uint8Array, mediaType: string, width: number, height: number } | null>} a fitting candidate, or null when unreachable.
 */
async function encodeWithinLimits(args) {
  const { sharp, data, facts, limits, config, logger } = args
  const source = orientDimensions(facts.width, facts.height, facts.orientation)
  const primary = pickTargetFormat(facts, config)
  let dims = targetDimensions(source.width, source.height, limits)
  let animated = facts.animated && config.animated !== 'passthrough' && config.targetFormat === 'auto'
  let attempts = 0

  for (let round = 0; round <= MAX_SHRINK_ROUNDS; round++) {
    const formats = round === 0 ? candidateFormats(primary) : [WEBP]
    const ladder = round === 0 ? config.qualityLadder : [config.qualityLadder[Math.min(1, config.qualityLadder.length - 1)]]

    for (const format of formats) {
      for (const quality of qualitiesFor(format, ladder)) {
        if (attempts >= MAX_ENCODE_ATTEMPTS) break
        attempts += 1
        let candidate
        try {
          candidate = await encodeCandidate(sharp, data, {
            dims,
            format,
            quality,
            animated,
            hasAlpha: facts.hasAlpha,
            alphaBackground: config.alphaBackground,
            source,
          })
        } catch (error) {
          if (animated) {
            // Animated re-encode is unsupported for this container: degrade to
            // a single frame rather than giving up on the image.
            logger?.debug?.(`animated re-encode failed (${describeError(error)}); falling back to the first frame`)
            animated = false
          } else {
            logger?.debug?.(`encode ${format} failed: ${describeError(error)}`)
          }
          continue
        }
        if (fitsLimits(candidate.width, candidate.height, candidate.data.byteLength, limits)) return candidate
      }
    }

    const next = shrinkDimensions(dims, 0.7)
    if (Math.max(next.width, next.height) < MIN_LONG_EDGE) break
    dims = next
  }

  return null
}

/**
 * @param {unknown} error arbitrary failure.
 * @returns {string} a short, log-safe description.
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Re-encode one already-valid input so it fits a tighter aggregate byte budget.
 *
 * @param {object} args shrink arguments.
 * @returns {Promise<{ data: Uint8Array, mediaType: string, width: number, height: number } | null>} a smaller candidate, or null.
 */
async function encodeUnderBudget(args) {
  const { sharp, input, facts, limits, config, logger, byteBudget } = args
  const tightened = { ...limits, maxImageBytes: byteBudget }
  return encodeWithinLimits({ sharp, data: input.data, facts, limits: tightened, config, logger })
}

/**
 * Build the repaired replacement for one input object, or return null when the
 * source should pass through untouched.
 *
 * @param {{ data: Uint8Array, mediaType?: string, name?: string }} input one attachment input.
 * @param {{ mediaType: string, data: Uint8Array, width: number, height: number } | null} encoded pre-encoded replacement, if any.
 * @param {string} mediaType final declared media type.
 * @returns {{ data: Uint8Array, mediaType: string, name?: string }} the replacement input.
 */
function relabel(input, encoded, mediaType) {
  const next = { ...input, mediaType }
  if (encoded !== null) next.data = encoded.data
  return next
}

/**
 * Repair one image input.
 *
 * @param {unknown} input candidate input.
 * @param {ReturnType<typeof readLimits>} limits effective admission limits.
 * @param {object} config resolved plugin config.
 * @param {{ sharp: Function, logger?: { info?: Function, debug?: Function, warn?: Function }, processed?: WeakSet<object> }} deps injected dependencies.
 * @returns {Promise<{ input: unknown, changed: boolean, fact: object | null }>} the possibly-repaired input.
 */
export async function repairOne(input, limits, config, deps) {
  const unchanged = { input, changed: false, fact: null }
  if (!isImageInput(input)) return unchanged
  if (deps.processed?.has(input)) return unchanged

  const { sharp, logger } = deps
  const startedAt = Date.now()
  const declared = normalizeDeclaredMediaType(input.mediaType)
  const supported = limits.mediaTypes
  const statedMediaType = typeof input.mediaType === 'string' ? input.mediaType : ''

  let meta
  try {
    meta = await sharp(input.data, { failOn: 'none', limitInputPixels: false }).metadata()
  } catch (error) {
    if (!config.tryPartialDecode) {
      logger?.debug?.(`header probe failed; passing through: ${describeError(error)}`)
      return unchanged
    }
    return repairByPartialDecode(input, limits, config, deps, startedAt)
  }

  const facts = describeMetadata(meta)
  if (facts.width <= 0 || facts.height <= 0) return unchanged

  const realType = mediaTypeForFormat(facts.format)
  const realAdmitted = realType !== null && isAdmittedMediaType(realType, supported)
  const dims = orientDimensions(facts.width, facts.height, facts.orientation)
  const violations = violationsFor(dims, input.data.byteLength, limits)
  const needsTranscode = !realAdmitted || violations.length > 0

  if (!needsTranscode) {
    const mediaType = realType === declared.mediaType ? declared.mediaType : realType
    if (mediaType === statedMediaType) return unchanged
    return {
      input: relabel(input, null, mediaType),
      changed: true,
      fact: factFor({ input, startedAt, action: 'relabel', declared: statedMediaType, realType, facts, to: { ...dims, bytes: input.data.byteLength, mediaType } }),
    }
  }

  // Never hand a decode bomb to libvips: an unrecoverable source keeps its
  // original error instead of taking the desktop process down.
  const pixels = dims.width * dims.height
  if (pixels > config.maxDecodePixels) {
    logger?.warn?.(`skipped ${facts.format ?? 'unknown'} ${dims.width}x${dims.height} (${pixels}px > maxDecodePixels ${config.maxDecodePixels}); passing through`)
    return unchanged
  }

  if (facts.animated && config.animated === 'passthrough') {
    logger?.debug?.(`animated source needs repair but animated=passthrough; passing through`)
    return unchanged
  }

  const encoded = await encodeWithinLimits({ sharp, data: input.data, facts, limits, config, logger })
  if (encoded === null) {
    logger?.warn?.(
      `${facts.width}x${facts.height} ${formatBytes(input.data.byteLength)} ${facts.format ?? 'unknown'} could not be repaired within limits (${violations.join('+') || 'unsupported-type'}); passing through`,
    )
    return unchanged
  }

  const mediaType = encoded.mediaType
  return {
    input: relabel(input, encoded, mediaType),
    changed: true,
    fact: factFor({
      input,
      startedAt,
      action: realAdmitted ? 'transcode' : 'convert',
      declared: statedMediaType,
      realType,
      facts,
      to: { width: encoded.width, height: encoded.height, bytes: encoded.data.byteLength, mediaType },
      violations,
    }),
  }
}

/**
 * Last-resort repair for sources whose header probe failed: attempt a lenient
 * full decode and re-encode. Only enabled by `tryPartialDecode`.
 *
 * @param {object} input candidate input.
 * @param {ReturnType<typeof readLimits>} limits effective limits.
 * @param {object} config resolved plugin config.
 * @param {object} deps injected dependencies.
 * @param {number} startedAt millisecond timestamp for latency logging.
 * @returns {Promise<{ input: unknown, changed: boolean, fact: object | null }>} the result.
 */
async function repairByPartialDecode(input, limits, config, deps, startedAt) {
  const { sharp, logger } = deps
  for (const format of [JPEG, PNG, WEBP]) {
    try {
      const candidate = await encodeCandidate(sharp, input.data, {
        dims: { width: 0, height: 0 },
        format,
        quality: config.qualityLadder[0],
        animated: false,
        hasAlpha: false,
        alphaBackground: config.alphaBackground,
        source: { width: 0, height: 0 },
      })
      if (!fitsLimits(candidate.width, candidate.height, candidate.data.byteLength, limits)) continue
      return {
        input: relabel(input, candidate, format),
        changed: true,
        fact: {
          index: -1,
          name: input.name,
          action: 'partial-decode',
          declared: String(input.mediaType ?? ''),
          real: 'unknown',
          reason: 'header probe failed; re-encoded from a lenient decode',
          from: { width: 0, height: 0, bytes: input.data.byteLength, mediaType: String(input.mediaType ?? '') },
          to: { width: candidate.width, height: candidate.height, bytes: candidate.data.byteLength, mediaType: format },
          ms: Date.now() - startedAt,
        },
      }
    } catch {
      // Try the next container.
    }
  }
  logger?.debug?.('partial decode produced nothing admissible; passing through')
  return { input, changed: false, fact: null }
}

/**
 * @param {{ input: object, startedAt: number, action: string, declared: string, realType: string | null, facts: object, to: object, violations?: string[] }} args fact inputs.
 * @returns {object} a log/report fact.
 */
function factFor(args) {
  const { input, startedAt, action, declared, realType, facts, to, violations } = args
  const from = orientDimensions(facts.width, facts.height, facts.orientation)
  return {
    index: -1,
    name: input.name,
    action,
    declared,
    real: facts.format ?? 'unknown',
    violations: violations ?? [],
    reason: violations && violations.length > 0 ? `over limit: ${violations.join('+')}` : `declared ${declared || '(empty)'} but bytes are ${realType ?? facts.format}`,
    from: { width: from.width, height: from.height, bytes: input.data.byteLength, mediaType: declared },
    to,
    ms: Date.now() - startedAt,
  }
}

/**
 * @param {number} bytes byte count.
 * @returns {string} human-readable size.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/**
 * Format one repair fact for the log: name, declaration, reality, geometry and
 * latency — never bytes or paths.
 *
 * @param {object} fact repair fact.
 * @returns {string} one log line body.
 */
export function describeFact(fact) {
  const name = typeof fact.name === 'string' && fact.name !== '' ? fact.name : '(unnamed)'
  const from = `${fact.from.width}x${fact.from.height} ${formatBytes(fact.from.bytes)} ${fact.declared || '(no type)'}`
  const to = `${fact.to.width}x${fact.to.height} ${formatBytes(fact.to.bytes)} ${fact.to.mediaType ?? ''}`.trim()
  return `${name}: ${from} -> ${to} [${fact.action}: ${fact.reason}; ${fact.ms}ms]`
}

/**
 * Run `worker` over `items` with a bounded number in flight, preserving order.
 *
 * @template T, R
 * @param {readonly T[]} items input items.
 * @param {number} limit maximum concurrency.
 * @param {(item: T, index: number) => Promise<R>} worker per-item task.
 * @returns {Promise<R[]>} results in input order.
 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  const width = Math.max(1, Math.min(items.length, Number.isFinite(limit) ? Math.trunc(limit) : 1))
  let cursor = 0
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Sentinel resolved by {@link withTimeout} when the budget expires.
 */
export const TIMED_OUT = Symbol('dsh-image-preflight.timed-out')

/**
 * Resolve to {@link TIMED_OUT} when `promise` does not settle inside `ms`.
 * The abandoned transform is left to finish on its own: sharp has no usable
 * cancellation, and waiting forever would block the whole prompt.
 *
 * @template T
 * @param {Promise<T>} promise work to bound.
 * @param {number} ms positive budget in milliseconds.
 * @returns {Promise<T | typeof TIMED_OUT>} the result or the timeout sentinel.
 */
export function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        // Surface failures through the same channel as results; callers treat
        // a rejection as "pass this input through".
        resolve(Promise.reject(error))
      },
    )
  })
}

/**
 * Repair one whole batch: per-image repair, then aggregate-byte relief.
 *
 * @param {readonly unknown[]} inputs attachment inputs in message order.
 * @param {ReturnType<typeof readLimits>} limits effective admission limits.
 * @param {object} config resolved plugin config.
 * @param {{ sharp: Function, logger?: object, processed?: WeakSet<object> }} deps injected dependencies.
 * @returns {Promise<{ inputs: unknown[], facts: object[] }>} repaired inputs in the same order.
 */
export async function repairBatch(inputs, limits, config, deps) {
  if (!Array.isArray(inputs) || inputs.length === 0) return { inputs, facts: [] }

  const outcomes = await mapLimit(inputs, config.concurrency, async (input) => {
    try {
      const outcome = await withTimeout(repairOne(input, limits, config, deps), config.transformTimeoutMs)
      if (outcome === TIMED_OUT) {
        deps.logger?.warn?.(`transform exceeded ${config.transformTimeoutMs}ms; passing this image through`)
        return { input, changed: false, fact: null }
      }
      return outcome
    } catch (error) {
      deps.logger?.warn?.(`repair failed, passing this image through: ${describeError(error)}`)
      return { input, changed: false, fact: null }
    }
  })

  const repaired = outcomes.map((outcome) => outcome.input)
  const facts = outcomes.map((outcome, index) => (outcome.fact === null ? null : { ...outcome.fact, index })).filter((fact) => fact !== null)

  const aggregate = await relieveAggregateBytes(inputs, repaired, limits, config, deps, facts)
  return { inputs: aggregate.inputs, facts: aggregate.facts }
}

/**
 * When the repaired batch is still above the aggregate byte cap, re-encode the
 * largest members — largest first — until the batch fits or nothing more can be
 * gained. Never drops an image.
 *
 * @param {readonly unknown[]} originals original inputs.
 * @param {unknown[]} repaired per-image repaired inputs.
 * @param {ReturnType<typeof readLimits>} limits effective limits.
 * @param {object} config resolved plugin config.
 * @param {object} deps injected dependencies.
 * @param {object[]} facts facts collected so far.
 * @returns {Promise<{ inputs: unknown[], facts: object[] }>} aggregate-relieved inputs.
 */
async function relieveAggregateBytes(originals, repaired, limits, config, deps, facts) {
  const total = () => repaired.reduce((sum, input) => sum + (isImageInput(input) ? input.data.byteLength : 0), 0)
  if (total() <= limits.maxMessageImageBytes) return { inputs: repaired, facts }

  const order = repaired
    .map((input, index) => ({ index, bytes: isImageInput(input) ? input.data.byteLength : 0 }))
    .filter((entry) => entry.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes || a.index - b.index)

  let attempts = 0
  let running = total()
  for (const entry of order) {
    if (running <= limits.maxMessageImageBytes) break
    if (attempts >= MAX_BATCH_ATTEMPTS) break
    attempts += 1

    const current = repaired[entry.index]
    const original = originals[entry.index]
    const startedAt = Date.now()
    try {
      const meta = await deps.sharp(current.data, { failOn: 'none', limitInputPixels: false }).metadata()
      const currentFacts = describeMetadata(meta)
      if (currentFacts.width <= 0 || currentFacts.height <= 0) continue
      const excess = running - limits.maxMessageImageBytes
      const byteBudget = Math.max(MIN_BATCH_BYTES, current.data.byteLength - excess - Math.ceil(excess * 0.1))
      const encoded = await encodeUnderBudget({ sharp: deps.sharp, input: current, facts: currentFacts, limits, config, logger: deps.logger, byteBudget })
      if (encoded === null || encoded.data.byteLength >= current.data.byteLength) continue
      running += encoded.data.byteLength - current.data.byteLength
      repaired[entry.index] = relabel(current, encoded, encoded.mediaType)
      facts.push({
        index: entry.index,
        name: current.name,
        action: 'batch',
        declared: String(original.mediaType ?? ''),
        real: currentFacts.format ?? 'unknown',
        violations: ['aggregate-bytes'],
        reason: `batch total over ${formatBytes(limits.maxMessageImageBytes)}`,
        from: { width: currentFacts.width, height: currentFacts.height, bytes: current.data.byteLength, mediaType: String(current.mediaType ?? '') },
        to: { width: encoded.width, height: encoded.height, bytes: encoded.data.byteLength, mediaType: encoded.mediaType },
        ms: Date.now() - startedAt,
      })
    } catch (error) {
      deps.logger?.debug?.(`aggregate relief skipped one image: ${describeError(error)}`)
    }
  }

  return { inputs: repaired, facts }
}
