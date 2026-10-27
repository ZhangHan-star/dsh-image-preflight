/**
 * Host wiring tests: the plugin must wrap the live attachment store exactly
 * once, repair through it, and restore the previous shape on unload — including
 * a wrapper another plugin already installed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../lib/index.js'
import { TIMED_OUT, withTimeout } from '../lib/repair.js'
import { DEFAULT_TEST_LIMITS, loadSharp, makeImage } from './helpers.mjs'

const sharp = await loadSharp()

function createStore() {
  const calls = { saveImages: 0, saveImage: 0 }
  const store = {
    imageLimits: { ...DEFAULT_TEST_LIMITS },
    async saveImages(inputs) {
      calls.saveImages += 1
      return Array.isArray(inputs) ? inputs.map((input) => ({ attachmentId: 'sha256:stub', mediaType: input.mediaType })) : []
    },
    async saveImage(input) {
      calls.saveImage += 1
      return { attachmentId: 'sha256:stub', mediaType: input.mediaType }
    },
  }
  return { store, calls }
}

function createContext(holder) {
  const cleanups = []
  let injected = null
  let injectDispose = null
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    get: (key) => (key === 'attachments' ? holder.store : undefined),
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['attachments'])
      injected = callback
      callback()
      return () => {
        injectDispose?.()
        injected = null
      }
    },
    effect: (callback) => {
      const dispose = callback()
      cleanups.push(dispose)
      return dispose
    },
  }
  return {
    ctx,
    reinject: () => injected?.(),
    dispose: () => {
      for (const cleanup of cleanups.splice(0)) cleanup?.()
    },
    injectDispose: () => injectDispose?.(),
  }
}

test('the wrapper repairs through saveImages and restores on unload', async () => {
  const { store, calls } = createStore()
  const holder = { store }
  const originalSaveImages = store.saveImages
  const originalSaveImage = store.saveImage
  const control = createContext(holder)

  apply(control.ctx, { logLevel: 'silent' })
  assert.notEqual(store.saveImages, originalSaveImages, 'saveImages is wrapped')
  assert.notEqual(store.saveImage, originalSaveImage, 'saveImage is wrapped')

  const input = { data: await makeImage(sharp, 40, 30, 'jpeg'), mediaType: 'image/png', name: 'fake.png' }
  const refs = await store.saveImages([input])

  assert.equal(calls.saveImages, 1)
  assert.equal(refs[0].mediaType, 'image/jpeg')

  control.dispose()
  assert.equal(store.saveImages, originalSaveImages, 'original method restored')
  assert.equal(store.saveImage, originalSaveImage)
  assert.equal(store[Symbol.for('dsh-image-preflight.wrapped')], undefined)
})

test('saveImage repairs a single image too', async () => {
  const { store, calls } = createStore()
  const control = createContext({ store })

  apply(control.ctx, { logLevel: 'silent' })
  const ref = await store.saveImage({ data: await makeImage(sharp, 24, 24, 'webp'), mediaType: 'image/png' })

  assert.equal(calls.saveImage, 1)
  assert.equal(ref.mediaType, 'image/webp')
  control.dispose()
})

test('a second activation never double-wraps the same store', async () => {
  const { store, calls } = createStore()
  const holder = { store }
  const first = createContext(holder)
  const second = createContext(holder)

  apply(first.ctx, { logLevel: 'silent' })
  const wrapper = store.saveImages
  apply(second.ctx, { logLevel: 'silent' })

  assert.equal(store.saveImages, wrapper, 'the store is wrapped once')
  const input = { data: await makeImage(sharp, 20, 20, 'jpeg'), mediaType: 'image/png' }
  await store.saveImages([input])
  assert.equal(calls.saveImages, 1)

  first.dispose()
  second.dispose()
})

test('enabled:false installs no wrapper at all', () => {
  const { store } = createStore()
  const original = store.saveImages
  const control = createContext({ store })

  apply(control.ctx, { enabled: false })

  assert.equal(store.saveImages, original)
  control.dispose()
})

test('a replaced service is wrapped and the stale one restored', async () => {
  const first = createStore()
  const second = createStore()
  const holder = { store: first.store }
  const firstOriginal = first.store.saveImages
  const secondOriginal = second.store.saveImages
  const control = createContext(holder)

  apply(control.ctx, { logLevel: 'silent' })
  assert.notEqual(first.store.saveImages, firstOriginal)

  holder.store = second.store
  control.reinject()

  assert.equal(first.store.saveImages, firstOriginal, 'stale store restored')
  assert.notEqual(second.store.saveImages, secondOriginal, 'new store wrapped')
  assert.notEqual(second.store[Symbol.for('dsh-image-preflight.wrapped')], undefined)

  control.dispose()
  assert.equal(second.store.saveImages, secondOriginal, 'new store restored on unload')
  assert.equal(second.store[Symbol.for('dsh-image-preflight.wrapped')], undefined)
})

test('unload restores a wrapper installed by another plugin', async () => {
  const { store } = createStore()
  const foreign = async (inputs) => inputs
  store.saveImages = foreign
  const control = createContext({ store })

  apply(control.ctx, { logLevel: 'silent' })
  assert.notEqual(store.saveImages, foreign)
  control.dispose()

  assert.equal(store.saveImages, foreign, 'the foreign wrapper survives our unload')
})

test('a non-array batch is handed to the original method untouched', async () => {
  const { store, calls } = createStore()
  const control = createContext({ store })
  apply(control.ctx, { logLevel: 'silent' })

  await store.saveImages(undefined)
  assert.equal(calls.saveImages, 1)
  control.dispose()
})

test('withTimeout returns its sentinel instead of hanging', async () => {
  const result = await withTimeout(new Promise(() => {}), 20)
  assert.equal(result, TIMED_OUT)
  assert.equal(await withTimeout(Promise.resolve('ok'), 50), 'ok')
})
