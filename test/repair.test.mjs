/**
 * Unit matrix for the repair pipeline (see README 能力矩阵 / capability matrix).
 * Fixtures are generated at run time; nothing binary is committed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveConfig } from '../lib/config.js'
import { repairBatch, repairOne } from '../lib/repair.js'
import {
  DEFAULT_TEST_LIMITS,
  animatedGif,
  corruptPng,
  factsOf,
  loadSharp,
  makeImage,
  recordingLogger,
  simulateAdmission,
} from './helpers.mjs'

const sharp = await loadSharp()
const config = (overrides = {}) => resolveConfig({ logLevel: 'silent', ...overrides })
const limits = (overrides = {}) => ({ ...DEFAULT_TEST_LIMITS, ...overrides })

test('JPEG bytes declared as image/png are relabelled and keep their exact bytes', async () => {
  const data = await makeImage(sharp, 64, 48, 'jpeg')
  const input = { data, mediaType: 'image/png', name: '淘宝/1793029414251.png' }

  const outcome = await repairOne(input, limits(), config(), { sharp, logger: recordingLogger() })

  assert.equal(outcome.changed, true)
  assert.equal(outcome.input.mediaType, 'image/jpeg')
  assert.equal(outcome.input.data, data, 'bytes must be the very same reference')
  assert.equal(outcome.input.name, '淘宝/1793029414251.png', 'name passes through untouched')
  await simulateAdmission(sharp, outcome.input, limits())
})

test('WebP bytes declared as image/png are relabelled', async () => {
  const data = await makeImage(sharp, 40, 40, 'webp')
  const input = { data, mediaType: 'image/png' }

  const outcome = await repairOne(input, limits(), config(), { sharp })

  assert.equal(outcome.input.mediaType, 'image/webp')
  assert.equal(outcome.input.data, data)
  await simulateAdmission(sharp, outcome.input, limits())
})

test('non-standard MIME aliases are normalised', async () => {
  const jpeg = await makeImage(sharp, 32, 32, 'jpeg')
  const outcome = await repairOne({ data: jpeg, mediaType: 'image/jpg' }, limits(), config(), { sharp })
  assert.equal(outcome.input.mediaType, 'image/jpeg')
  await simulateAdmission(sharp, outcome.input, limits())

  const png = await makeImage(sharp, 32, 32, 'png')
  const pngOutcome = await repairOne({ data: png, mediaType: 'IMAGE/X-PNG; charset=binary' }, limits(), config(), { sharp })
  assert.equal(pngOutcome.input.mediaType, 'image/png')
  await simulateAdmission(sharp, pngOutcome.input, limits())
})

test('declared but unsupported type with supported bytes is relabelled', async () => {
  const jpeg = await makeImage(sharp, 32, 32, 'jpeg')
  const outcome = await repairOne({ data: jpeg, mediaType: 'image/avif' }, limits(), config(), { sharp })

  assert.equal(outcome.input.mediaType, 'image/jpeg')
  assert.equal(outcome.input.data, jpeg)
  await simulateAdmission(sharp, outcome.input, limits())
})

test('a compliant image is passed through by reference with zero re-encoding', async () => {
  const data = await makeImage(sharp, 100, 80, 'png')
  const input = { data, mediaType: 'image/png', name: 'clean.png' }

  const outcome = await repairOne(input, limits(), config(), { sharp })

  assert.equal(outcome.changed, false)
  assert.equal(outcome.input, input, 'the input object itself is returned')
  assert.equal(outcome.input.data, data)
})

test('unsupported but decodable containers are transcoded to an admitted type', async () => {
  const tiff = await makeImage(sharp, 120, 90, 'tiff')
  const input = { data: tiff, mediaType: 'image/png', name: 'scan.png' }

  const outcome = await repairOne(input, limits(), config(), { sharp })

  assert.equal(outcome.changed, true)
  assert.ok(['image/jpeg', 'image/webp'].includes(outcome.input.mediaType), `unexpected ${outcome.input.mediaType}`)
  assert.notEqual(outcome.input.data, tiff)
  await simulateAdmission(sharp, outcome.input, limits())
})

test('pixel-count overrun is shrunk within the limit and keeps its aspect ratio', async () => {
  const data = await makeImage(sharp, 400, 300, 'png')
  const limited = limits({ maxImagePixels: 40_000 })

  const outcome = await repairOne({ data, mediaType: 'image/png' }, limited, config(), { sharp })

  assert.equal(outcome.changed, true)
  const facts = await factsOf(sharp, outcome.input.data)
  assert.ok(facts.width * facts.height <= 40_000, `${facts.width}x${facts.height} over budget`)
  const expectedWidth = 400 * (facts.height / 300)
  assert.ok(Math.abs(facts.width - expectedWidth) <= 1, 'aspect ratio drift above 1px')
  await simulateAdmission(sharp, outcome.input, limited)
})

test('a 9000px long image is capped to the per-side dimension limit', async () => {
  const data = await makeImage(sharp, 9000, 90, 'png')

  const outcome = await repairOne({ data, mediaType: 'image/png' }, limits(), config(), { sharp })

  assert.equal(outcome.changed, true)
  const facts = await factsOf(sharp, outcome.input.data)
  assert.ok(Math.max(facts.width, facts.height) <= 8192, `long edge ${Math.max(facts.width, facts.height)}`)
  await simulateAdmission(sharp, outcome.input, limits())
})

test('an over-byte image is re-encoded under the byte limit', async () => {
  const data = await makeImage(sharp, 600, 600, 'png')
  assert.ok(data.byteLength > 200_000, `fixture too small: ${data.byteLength}`)
  const limited = limits({ maxImageBytes: 200_000 })

  const outcome = await repairOne({ data, mediaType: 'image/png' }, limited, config(), { sharp })

  assert.equal(outcome.changed, true)
  assert.ok(outcome.input.data.byteLength <= 200_000, `${outcome.input.data.byteLength} bytes`)
  await simulateAdmission(sharp, outcome.input, limited)
})

test('an oversized image with alpha becomes WebP and keeps transparency', async () => {
  const data = await makeImage(sharp, 500, 500, 'png', 4)
  const limited = limits({ maxImageBytes: 120_000 })

  const outcome = await repairOne({ data, mediaType: 'image/png' }, limited, config(), { sharp })

  assert.equal(outcome.changed, true)
  const facts = await factsOf(sharp, outcome.input.data)
  assert.equal(facts.format, 'webp', 'alpha sources must not become JPEG')
  assert.equal(facts.hasAlpha, true)
  await simulateAdmission(sharp, outcome.input, limited)
})

test('an oversized animated GIF keeps its frames under animated=shrink', async () => {
  const data = animatedGif()
  const limited = limits({ maxImageDimension: 1 })

  const outcome = await repairOne({ data, mediaType: 'image/gif' }, limited, config({ animated: 'shrink' }), { sharp })

  assert.equal(outcome.changed, true)
  const facts = await factsOf(sharp, outcome.input.data)
  assert.equal(facts.pages, 2, 'both frames survive')
  assert.equal(facts.format, 'webp')
})

test('animated=first-frame keeps only one frame', async () => {
  const outcome = await repairOne({ data: animatedGif(), mediaType: 'image/gif' }, limits({ maxImageDimension: 1 }), config({ animated: 'first-frame' }), { sharp })

  assert.equal(outcome.changed, true)
  const facts = await factsOf(sharp, outcome.input.data)
  assert.equal(facts.pages, 1)
})

test('animated=passthrough leaves an oversized animation alone', async () => {
  const data = animatedGif()
  const input = { data, mediaType: 'image/gif' }

  const outcome = await repairOne(input, limits({ maxImageDimension: 1 }), config({ animated: 'passthrough' }), { sharp })

  assert.equal(outcome.changed, false)
  assert.equal(outcome.input, input)
})

test('a corrupt image passes through and is still refused upstream', async () => {
  const data = corruptPng()
  const input = { data, mediaType: 'image/png', name: 'broken.png' }

  const outcome = await repairOne(input, limits(), config(), { sharp })

  assert.equal(outcome.changed, false)
  assert.equal(outcome.input, input)
  await assert.rejects(() => simulateAdmission(sharp, outcome.input, limits()), /INVALID_IMAGE/)
})

test('empty and non-byte inputs are passed through untouched', async () => {
  for (const input of [null, undefined, {}, { data: new Uint8Array(0), mediaType: 'image/png' }, { data: 'not-bytes', mediaType: 'image/png' }]) {
    const outcome = await repairOne(input, limits(), config(), { sharp })
    assert.equal(outcome.changed, false)
    assert.equal(outcome.input, input)
  }
})

test('a batch keeps order, repairs only what is broken and still admits', async () => {
  const clean = { data: await makeImage(sharp, 50, 50, 'png'), mediaType: 'image/png', name: 'a.png' }
  const lying = { data: await makeImage(sharp, 60, 40, 'jpeg'), mediaType: 'image/png', name: 'b.png' }
  const huge = { data: await makeImage(sharp, 700, 500, 'png'), mediaType: 'image/png', name: 'c.png' }
  const limited = limits({ maxImageBytes: 250_000 })

  const result = await repairBatch([clean, lying, huge], limited, config(), { sharp, logger: recordingLogger() })

  assert.equal(result.inputs.length, 3)
  assert.equal(result.inputs[0], clean, 'compliant member is untouched')
  assert.equal(result.inputs[1].mediaType, 'image/jpeg')
  assert.equal(result.inputs[1].name, 'b.png')
  assert.ok(result.inputs[2].data.byteLength <= 250_000)
  for (const input of result.inputs) await simulateAdmission(sharp, input, limited)
  assert.deepEqual(
    result.facts.map((fact) => fact.index),
    [1, 2],
  )
})

test('20 valid images plus 1 oversized image only repairs the oversized one', async () => {
  const clean = await makeImage(sharp, 32, 32, 'png')
  const inputs = Array.from({ length: 20 }, (_, index) => ({ data: clean, mediaType: 'image/png', name: `${index}.png` }))
  const oversized = { data: await makeImage(sharp, 700, 500, 'png'), mediaType: 'image/png', name: 'big.png' }
  inputs.push(oversized)
  const limited = limits({ maxImageBytes: 250_000 })

  const result = await repairBatch(inputs, limited, config(), { sharp })

  for (let index = 0; index < 20; index += 1) assert.equal(result.inputs[index], inputs[index])
  assert.notEqual(result.inputs[20], oversized)
  assert.ok(result.inputs[20].data.byteLength <= 250_000)
})

test('an over-aggregate batch is relieved without dropping an image', async () => {
  const first = await makeImage(sharp, 420, 420, 'png')
  const inputs = [
    { data: first, mediaType: 'image/png', name: '1.png' },
    { data: first, mediaType: 'image/png', name: '2.png' },
    { data: first, mediaType: 'image/png', name: '3.png' },
  ]
  const limited = limits({ maxMessageImageBytes: 600_000 })
  assert.ok(first.byteLength * 3 > 600_000, 'fixture must exceed the aggregate cap')

  const result = await repairBatch(inputs, limited, config(), { sharp, logger: recordingLogger() })

  const total = result.inputs.reduce((sum, input) => sum + input.data.byteLength, 0)
  assert.equal(result.inputs.length, 3)
  assert.ok(total <= 600_000, `aggregate ${total} still over the cap`)
  for (const input of result.inputs) await simulateAdmission(sharp, input, limited)
})

test('a decode bomb above maxDecodePixels is never decoded', async () => {
  const data = await makeImage(sharp, 9000, 90, 'png')
  const logger = recordingLogger()

  const outcome = await repairOne({ data, mediaType: 'image/png' }, limits(), config({ maxDecodePixels: 1000 }), { sharp, logger })

  assert.equal(outcome.changed, false)
  assert.ok(logger.lines.some((line) => line.includes('maxDecodePixels')))
})

test('the same input object is never processed twice', async () => {
  const data = await makeImage(sharp, 64, 48, 'jpeg')
  const input = { data, mediaType: 'image/png' }
  const processed = new WeakSet()

  const first = await repairOne(input, limits(), config(), { sharp, processed })
  processed.add(first.input)
  const second = await repairOne(first.input, limits(), config({ maxImageBytes: 1000 }), { sharp, processed })

  assert.equal(first.changed, true)
  assert.equal(second.changed, false, 'a marked input must short-circuit')
  assert.equal(second.input, first.input)
})

test('repair output is deterministic for identical input', async () => {
  const data = await makeImage(sharp, 640, 480, 'png')
  const limited = limits({ maxImageBytes: 200_000 })
  const first = await repairOne({ data, mediaType: 'image/png' }, limited, config(), { sharp })
  const second = await repairOne({ data, mediaType: 'image/png' }, limited, config(), { sharp })
  assert.deepEqual([...first.input.data], [...second.input.data])
})
