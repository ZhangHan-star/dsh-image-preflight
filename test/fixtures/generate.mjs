/**
 * Materialise every fixture in `cases.mjs` into `test/fixtures/files/`.
 * Run with: node test/fixtures/generate.mjs [--clean] [--only=A1,B2]
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadSharp } from '../../lib/sharp.js'
import { CASES } from '../cases.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Directory every generated fixture lands in. */
export const FILES_DIR = join(HERE, 'files')

/**
 * Generate fixtures on disk.
 *
 * @param {{ clean?: boolean, only?: string[] }} [options] generation options.
 * @returns {Promise<Array<{ id: string, path: string, bytes: number, files: number }>>} written entries.
 */
export async function generate(options = {}) {
  const { clean = false, only } = options
  const sharp = await loadSharp()
  if (clean) await rm(FILES_DIR, { recursive: true, force: true })
  await mkdir(FILES_DIR, { recursive: true })

  const written = []
  for (const testCase of CASES) {
    if (Array.isArray(only) && only.length > 0 && !only.includes(testCase.id)) continue
    const produced = await testCase.make(sharp)

    if (testCase.dir) {
      const target = join(FILES_DIR, testCase.file)
      await mkdir(target, { recursive: true })
      let bytes = 0
      const files = Object.entries(produced)
      for (const [name, data] of files) {
        const buffer = Buffer.from(data)
        await writeFile(join(target, name), buffer)
        bytes += buffer.length
      }
      written.push({ id: testCase.id, path: target, bytes, files: files.length })
    } else {
      const buffer = Buffer.from(produced)
      const target = join(FILES_DIR, testCase.file)
      await writeFile(target, buffer)
      written.push({ id: testCase.id, path: target, bytes: buffer.length, files: 1 })
    }
  }

  if (!Array.isArray(only) || only.length === 0) await writeIndex()
  return written
}

/**
 * Write a human index beside the fixtures, so the folder is self-describing
 * when dragged from.
 *
 * @returns {Promise<void>} completion.
 */
async function writeIndex() {
  const lines = [
    '# 测试图片索引 · dsh-image-preflight',
    '',
    '把这里的文件拖进 DSH 的输入框：标"应该通过"的应当能发出去，标"应该仍然报"的应当和以前一样被拒。',
    '',
    '| # | 文件 | 这是什么 | 期望结果 | GUI |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const testCase of CASES) {
    const target = testCase.expect.admission === 'accept' ? '✅ 应该通过' : `❌ 应该仍然报 ${testCase.expect.code}`
    const gui = testCase.guiBlocked ? `⛔ ${testCase.guiBlocked}` : '可测'
    lines.push(`| ${testCase.id} | \`${testCase.file}\` | ${testCase.title} | ${target} | ${gui} |`)
  }
  lines.push('', '生成命令：`node test/fixtures/generate.mjs --clean`')
  await writeFile(join(FILES_DIR, '_INDEX.md'), lines.join('\n'), 'utf8')
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const clean = process.argv.includes('--clean')
  const onlyArg = process.argv.find((arg) => arg.startsWith('--only='))
  const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((value) => value.trim()).filter(Boolean) : undefined

  const started = Date.now()
  const written = await generate({ clean, only })
  let total = 0
  console.log(`输出目录: ${FILES_DIR}\n`)
  console.log('id    文件                                             字节        数量')
  console.log('----  -----------------------------------------------  ----------  ----')
  for (const entry of written) {
    total += entry.bytes
    const name = entry.path.slice(FILES_DIR.length + 1)
    console.log(`${entry.id.padEnd(4)}  ${name.padEnd(49)}  ${String(entry.bytes).padStart(10)}  ${String(entry.files).padStart(4)}`)
  }
  console.log(`\n共 ${written.length} 组，${(total / 1024 / 1024).toFixed(1)} MB，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
}
