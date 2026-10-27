/**
 * dsh-image-preflight — upload preflight for DSH image attachments.
 *
 * DSH admits an image only when its declared media type matches the bytes, its
 * size, pixel count and per-side dimension fit, and its container is one of
 * PNG/JPEG/WebP/GIF. Browsers derive the declared media type from the file
 * extension, so a JPEG saved as `photo.png` — extremely common on download
 * pages, chat apps and phones — is refused with
 * "仅支持 PNG、JPG、WebP、GIF 格式的图片" even though it is a perfectly good
 * picture.
 *
 * This plugin repairs the *source* before admission instead of changing
 * admission: it relabels lying declarations without touching a byte, transcodes
 * only what really is oversized or in an unsupported container, and passes
 * everything else through untouched so the original error codes and their
 * client copy are preserved exactly.
 *
 * There is no Client half: thumbnails, the draft strip, history, zoom and
 * reuse all keep their native behaviour.
 */
import { DEFAULT_CONFIG, resolveConfig } from './config.js'
import { readLimits } from './limits.js'
import { describeFact, repairBatch, repairOne } from './repair.js'
import { loadSharp } from './sharp.js'

export const name = 'dsh-image-preflight'
export { DEFAULT_CONFIG, resolveConfig }

/** Marks a wrapped `attachments` instance; `Symbol.for` survives module reloads. */
const WRAP = Symbol.for('dsh-image-preflight.wrapped')

/**
 * Build a logger bound to this plugin's context.
 *
 * Cordis may expose `ctx.logger` as a scoped object or as a factory; both are
 * supported, and a context without a logger degrades to silence.
 *
 * @param {object} ctx plugin context.
 * @param {object} config resolved config.
 * @returns {{ info: (message: string) => void, warn: (message: string) => void, debug: (message: string) => void }} logger.
 */
export function createLogger(ctx, config) {
  const level = config.logLevel
  const prefix = '[image-preflight] '
  let sink = null

  const logger = ctx?.logger
  if (logger && typeof logger.info === 'function') {
    sink = (method, message) => {
      const write = typeof logger[method] === 'function' ? logger[method] : logger.info
      write.call(logger, prefix + message)
    }
  } else if (typeof logger === 'function') {
    try {
      const scoped = logger('image-preflight')
      if (scoped && typeof scoped.info === 'function') {
        sink = (method, message) => {
          const write = typeof scoped[method] === 'function' ? scoped[method] : scoped.info
          write.call(scoped, message)
        }
      }
    } catch {
      sink = null
    }
  }

  const emit = (method, message) => {
    if (sink === null) return
    try {
      sink(method, message)
    } catch {
      // A broken logger must never break an upload.
    }
  }

  return {
    info: (message) => {
      if (level !== 'silent') emit('info', message)
    },
    warn: (message) => {
      if (level !== 'silent') emit('warn', message)
    },
    debug: (message) => {
      if (level === 'debug') emit('debug', message)
    },
  }
}

/**
 * Plugin entry point.
 *
 * @param {object} ctx Cordis plugin context.
 * @param {Record<string, unknown>} [rawConfig] the Loader row's `config`.
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  const logger = createLogger(ctx, config)
  const processed = new WeakSet()
  const token = Symbol('dsh-image-preflight.owner')
  /** @type {Map<object, () => void>} wrapped target → exact restore function. */
  const wrapped = new Map()

  let sharpPromise = null
  const getSharp = () => {
    if (sharpPromise === null) {
      sharpPromise = loadSharp().then(
        (sharp) => sharp,
        (error) => {
          logger.warn(`sharp is unavailable; the plugin now passes every image straight through (${error.message})`)
          return null
        },
      )
    }
    return sharpPromise
  }

  /**
   * Wrap one live attachment store. The previous own-property shape is captured
   * so unload restores the exact prior state — including another plugin's
   * wrapper, when one is installed.
   *
   * @param {object} target live `ctx.attachments` instance.
   * @returns {void}
   */
  const wrapTarget = (target) => {
    if (target[WRAP]) return
    const priorSaveImages = Object.getOwnPropertyDescriptor(target, 'saveImages')
    const priorSaveImage = Object.getOwnPropertyDescriptor(target, 'saveImage')
    const originalSaveImages = target.saveImages
    const originalSaveImage = target.saveImage

    const wrappedSaveImages = async function saveImages(inputs) {
      const sharp = await getSharp()
      if (sharp === null || !Array.isArray(inputs) || inputs.length === 0) return originalSaveImages.call(target, inputs)
      const limits = readLimits(target, config)
      const result = await repairBatch(inputs, limits, config, { sharp, logger, processed })
      for (const item of result.inputs) {
        if (item !== null && typeof item === 'object') processed.add(item)
      }
      for (const fact of result.facts) logger.info(describeFact(fact))
      return originalSaveImages.call(target, result.inputs)
    }

    const wrappedSaveImage = async function saveImage(input) {
      const sharp = await getSharp()
      if (sharp === null || input === null || typeof input !== 'object') return originalSaveImage.call(target, input)
      const limits = readLimits(target, config)
      const outcome = await repairOne(input, limits, config, { sharp, logger, processed })
      if (outcome.changed) {
        processed.add(outcome.input)
        logger.info(describeFact(outcome.fact))
      }
      return originalSaveImage.call(target, outcome.input)
    }

    target.saveImages = wrappedSaveImages
    target.saveImage = wrappedSaveImage
    Object.defineProperty(target, WRAP, { value: { owner: token }, configurable: true, enumerable: false, writable: true })

    const restore = () => {
      if (target[WRAP]?.owner !== token) return
      if (target.saveImages === wrappedSaveImages) {
        if (priorSaveImages) Object.defineProperty(target, 'saveImages', priorSaveImages)
        else delete target.saveImages
      }
      if (target.saveImage === wrappedSaveImage) {
        if (priorSaveImage) Object.defineProperty(target, 'saveImage', priorSaveImage)
        else delete target.saveImage
      }
      delete target[WRAP]
    }
    wrapped.set(target, restore)
  }

  /**
   * Re-run on every `attachments` service change (late readiness, hot reload).
   *
   * @returns {void}
   */
  const ensureWrap = () => {
    const target = ctx.get('attachments')
    if (!target || typeof target.saveImages !== 'function' || typeof target.saveImage !== 'function') return
    if (target[WRAP]) return
    for (const [previous, restore] of wrapped) {
      // The store was replaced: stop wrapping the stale instance.
      if (previous !== target) {
        restore()
        wrapped.delete(previous)
      }
    }
    try {
      wrapTarget(target)
      logger.debug(`wrapped attachments ${target.constructor?.name ?? ''}`.trim())
    } catch (error) {
      logger.warn(`unable to wrap the attachments service: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  let disposeInject = null
  disposeInject = ctx.inject(['attachments'], ensureWrap)

  ctx.effect(() => () => {
    try {
      disposeInject?.()
    } catch {
      // Already disposed: nothing to undo.
    }
    for (const restore of [...wrapped.values()]) {
      try {
        restore()
      } catch {
        // A failed restore must not block plugin teardown.
      }
    }
    wrapped.clear()
  })
}
