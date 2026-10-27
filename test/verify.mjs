/**
 * Assert every catalogue case against the real plugin and the real admission
 * rules, then write a human-readable report.
 *
 * Run with: node test/verify.mjs [--regen] [--skip-heavy]
 */
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../lib/config.js'
import { repairBatch } from '../lib/repair.js'
import { loadSharp } from '../lib/sharp.js'
import { CASES } from './cases.mjs'
import { FILES_DIR, generate } from './fixtures/generate.mjs'
import { DEFAULT_TEST_LIMITS, recordingLogger, simulateAdmission } from './helpers.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPORT_PATH = join(HERE, 'fixtures', 'REPORT.md')

const EXTENSION_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * @param {string} name file name.
 * @returns {string} the media type a browser derives from its extension.
 */
function declaredFromName(name) {
  const match = /\.[^.]+$/.exec(name)
  return match ? (EXTENSION_TYPES[match[0].toLowerCase()] ?? '') : ''
}

/**
 * @param {string} code attachment error code.
 * @returns {Error} an error carrying that code.
 */
function codeError(code) {
  const error = new Error(code)
  error.code = code
  return error
}

/**
 * Mirror `validateImageBatch` then the per-image admission.
 *
 * @param {Function} sharp callable sharp.
 * @param {Array<{ data: Uint8Array, mediaType?: string }>} inputs batch in message order.
 * @param {typeof DEFAULT_TEST_LIMITS} limits admission limits.
 * @returns {Promise<void>} resolves when the batch would be admitted.
 */
async function simulateBatchAdmission(sharp, inputs, limits) {
  if (inputs.length > limits.maxImagesPerMessage) throw codeError('TOO_MANY_IMAGES')
  if (inputs.reduce((sum, input) => sum + input.data.byteLength, 0) > limits.maxMessageImageBytes) throw codeError('IMAGES_TOO_LARGE')
  for (const input of inputs) await simulateAdmission(sharp, input, limits)
}

/**
 * @param {Function} sharp callable sharp.
 * @param {Uint8Array} data encoded bytes.
 * @returns {Promise<{ format?: string, width: number, height: number, pages: number, hasAlpha: boolean, bytes: number }>} measured facts.
 */
async function measure(sharp, data) {
  const meta = await sharp(data, { failOn: 'none', limitInputPixels: false }).metadata()
  return {
    format: meta.format,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    pages: meta.pages ?? 1,
    hasAlpha: meta.hasAlpha === true,
    bytes: data.byteLength,
  }
}

/**
 * Read one case's inputs off disk.
 *
 * @param {object} testCase catalogue entry.
 * @returns {Promise<Array<{ name: string, data: Uint8Array, mediaType?: string }>>} inputs.
 */
async function readInputs(testCase) {
  if (testCase.dir) {
    const dir = join(FILES_DIR, testCase.file)
    const names = (await readdir(dir)).sort()
    const inputs = []
    for (const name of names) {
      inputs.push({ name, data: new Uint8Array(await readFile(join(dir, name))), mediaType: declaredFromName(name) })
    }
    return inputs
  }
  const name = testCase.file
  return [{ name, data: new Uint8Array(await readFile(join(FILES_DIR, name))), mediaType: testCase.declared }]
}

/**
 * Run and grade one catalogue case.
 *
 * @param {object} testCase catalogue entry.
 * @param {Function} sharp callable sharp.
 * @returns {Promise<{ id: string, title: string, ok: boolean, checks: Array<{ ok: boolean, label: string }>, facts: object[], detail: object }>} result.
 */
async function evaluate(testCase, sharp) {
  const checks = []
  const check = (ok, label) => checks.push({ ok: Boolean(ok), label })
  const limits = DEFAULT_TEST_LIMITS
  const config = resolveConfig({ logLevel: 'silent' })
  const logger = recordingLogger()
  const expect = testCase.expect
  const inputs = await readInputs(testCase)

  const result = await repairBatch(inputs, limits, config, { sharp, logger })
  const outputs = result.inputs

  let admissionError = null
  try {
    await simulateBatchAdmission(sharp, outputs, limits)
  } catch (error) {
    admissionError = error
  }

  if (expect.admission === 'accept') {
    check(admissionError === null, admissionError ? `准入被拒: ${admissionError.code ?? admissionError.message}` : '准入通过')
  } else {
    check(admissionError?.code === expect.code, `准入被拒且错误码为 ${expect.code}（实际 ${admissionError?.code ?? '未拒绝'}）`)
    check(admissionError?.message === expect.code, '错误信息未被插件改写')
  }

  if (expect.count !== undefined) check(outputs.length === expect.count, `数量保持 ${expect.count}（实际 ${outputs.length}）`)
  if (expect.order !== undefined) {
    const names = outputs.map((input) => input.name)
    check(JSON.stringify(names) === JSON.stringify(expect.order), `顺序保持 ${expect.order.join(' → ')}`)
  }

  const changedIndexes = outputs.map((input, index) => (input === inputs[index] ? -1 : index)).filter((index) => index >= 0)
  if (expect.changedCount !== undefined) {
    check(changedIndexes.length === expect.changedCount, `改动数 ${expect.changedCount}（实际 ${changedIndexes.length}）`)
  }

  const single = !testCase.dir
  const first = outputs[0]
  const firstFact = result.facts.find((fact) => fact.index === 0) ?? null

  if (single && expect.changed !== undefined) {
    check((first !== inputs[0]) === expect.changed, expect.changed ? '插件改写了输入' : '插件未改动输入')
  }
  if (single && expect.action !== undefined) {
    const action = firstFact?.action ?? 'none'
    check(action === expect.action, `动作 ${expect.action}（实际 ${action}）`)
  }
  if (single && expect.bytesUnchanged !== undefined) {
    check((first.data === inputs[0].data) === expect.bytesUnchanged, expect.bytesUnchanged ? '字节引用未变' : '字节已更换')
  }
  if (single && expect.mediaType !== undefined) {
    const allowed = Array.isArray(expect.mediaType) ? expect.mediaType : [expect.mediaType]
    check(allowed.includes(first.mediaType), `最终声明 ${allowed.join(' | ')}（实际 ${first.mediaType}）`)
  }

  if (single && (expect.maxBytes ?? expect.maxPixels ?? expect.longEdge ?? expect.hasAlpha ?? expect.pages ?? expect.mediaType)) {
    const facts = await measure(sharp, first.data)
    if (expect.maxBytes !== undefined) check(facts.bytes <= expect.maxBytes, `体积 ${(facts.bytes / 1024 / 1024).toFixed(2)} MB ≤ ${(expect.maxBytes / 1024 / 1024).toFixed(0)} MB`)
    if (expect.maxPixels !== undefined) check(facts.width * facts.height <= expect.maxPixels, `像素 ${facts.width * facts.height} ≤ ${expect.maxPixels}`)
    if (expect.longEdge !== undefined) check(Math.max(facts.width, facts.height) <= expect.longEdge, `长边 ${Math.max(facts.width, facts.height)} ≤ ${expect.longEdge}`)
    if (expect.hasAlpha !== undefined) check(facts.hasAlpha === expect.hasAlpha, `透明通道 ${facts.hasAlpha}`)
    if (expect.pages !== undefined) check(facts.pages === expect.pages, `帧数 ${facts.pages}`)
  }

  const ok = checks.every((entry) => entry.ok)
  return {
    id: testCase.id,
    title: testCase.title,
    ok,
    checks,
    facts: result.facts,
    detail: result.facts.map((fact) => fact.action).join(',') || 'none',
  }
}

/**
 * @returns {Promise<boolean>} whether the fixture directory already has content.
 */
async function fixturesExist() {
  try {
    await access(FILES_DIR)
    return true
  } catch {
    return false
  }
}

/**
 * @param {Array<object>} results graded cases.
 * @returns {string} Markdown report body.
 */
function renderReport(results) {
  const passed = results.filter((entry) => entry.ok).length
  const lines = [
    '# dsh-image-preflight · 自动化核验报告',
    '',
    `生成时间：${new Date().toISOString()}`,
    '',
    `结果：**${passed} / ${results.length} 通过**`,
    '',
    '| 用例 | 标题 | 结果 | 插件动作 | 断言 |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const entry of results) {
    const checks = entry.checks.map((check) => `${check.ok ? '✓' : '✗'} ${check.label}`).join('<br>')
    lines.push(`| ${entry.id} | ${entry.title} | ${entry.ok ? '✅' : '❌'} | ${entry.detail} | ${checks} |`)
  }
  lines.push('')
  return lines.join('\n')
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const sharp = await loadSharp()
  if (process.argv.includes('--regen') || !(await fixturesExist())) {
    console.log('生成测试图片…')
    await generate({ clean: true })
  }

  const skipHeavy = process.argv.includes('--skip-heavy')
  const results = []
  const started = Date.now()

  for (const testCase of CASES) {
    if (skipHeavy && testCase.heavy) continue
    try {
      const result = await evaluate(testCase, sharp)
      results.push(result)
      console.log(`${result.ok ? '✅' : '❌'} ${result.id.padEnd(4)} ${result.title}`)
      for (const check of result.checks) if (!check.ok) console.log(`      ✗ ${check.label}`)
    } catch (error) {
      results.push({ id: testCase.id, title: testCase.title, ok: false, checks: [{ ok: false, label: `执行异常: ${error.message}` }], facts: [], detail: 'error' })
      console.log(`❌ ${testCase.id.padEnd(4)} ${testCase.title}\n      ✗ ${error.message}`)
    }
  }

  const passed = results.filter((entry) => entry.ok).length
  const report = renderReport(results)
  await writeFile(REPORT_PATH, report, 'utf8')
  console.log(`\n通过 ${passed}/${results.length}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(`报告：${REPORT_PATH}`)
  if (passed !== results.length) process.exitCode = 1
}
