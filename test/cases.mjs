/**
 * The complete test catalogue for dsh-image-preflight.
 *
 * One entry per real-world situation. `make` produces the bytes (nothing binary
 * is committed), `expect` is what the plugin and the Host admission must do.
 * `generate.mjs` writes the files, `verify.mjs` asserts the expectations, and
 * `guiBlocked` names the cases the composer can never deliver to the Host.
 *
 * Browser behaviour is modelled by `declared`: the media type Chrome derives
 * from the file extension (empty for an extensionless file).
 */
import { makeImage, noise } from './helpers.mjs'
import { encodeAnimatedGif, encodeBmp24, encodePng16, encodeSvg } from './fixtures/encoders.mjs'

/** JPEG quality used for fixtures that must stay small. */
const q = 82

/**
 * @param {Function} sharp callable sharp.
 * @param {number} width pixels.
 * @param {number} height pixels.
 * @param {string} format output format.
 * @returns {Promise<Buffer>} encoded solid image.
 */
async function solid(sharp, width, height, format) {
  return Buffer.from(await sharp({ create: { width, height, channels: 3, background: '#204a7a' } }).toFormat(format).toBuffer())
}

/** @type {Array<object>} */
export const CASES = [
  // ── A. 声明说谎 / 非标准 MIME：应「只改声明，不动字节」 ──────────────────
  {
    id: 'A1',
    group: 'A 类型说谎',
    file: 'A1-fake-png-real-jpeg.png',
    title: 'JPEG 字节，扩展名 .png（淘宝/微信导出的典型）',
    symptom: '以前报「仅支持 PNG、JPG、WebP、GIF 格式的图片」',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'relabel', changed: true, mediaType: 'image/jpeg', bytesUnchanged: true },
    make: async (sharp) => makeImage(sharp, 320, 240, 'jpeg'),
  },
  {
    id: 'A2',
    group: 'A 类型说谎',
    file: 'A2-fake-png-real-webp.png',
    title: 'WebP 字节，扩展名 .png',
    symptom: '报「仅支持 PNG、JPG、WebP、GIF 格式的图片」',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'relabel', changed: true, mediaType: 'image/webp', bytesUnchanged: true },
    make: async (sharp) => makeImage(sharp, 320, 240, 'webp'),
  },
  {
    id: 'A3',
    group: 'A 类型说谎',
    file: 'A3-fake-jpg-real-png.jpg',
    title: 'PNG 字节，扩展名 .jpg（截图工具常见）',
    symptom: '报「仅支持 PNG、JPG、WebP、GIF 格式的图片」',
    declared: 'image/jpeg',
    expect: { admission: 'accept', action: 'relabel', changed: true, mediaType: 'image/png', bytesUnchanged: true },
    make: async (sharp) => makeImage(sharp, 320, 240, 'png'),
  },
  {
    id: 'A4',
    group: 'A 类型说谎',
    file: 'A4-fake-png-real-gif.png',
    title: 'GIF 字节，扩展名 .png',
    symptom: '报「仅支持 PNG、JPG、WebP、GIF 格式的图片」',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'relabel', changed: true, mediaType: 'image/gif', bytesUnchanged: true },
    make: async (sharp) => Buffer.from(await sharp(noise(160, 120, 3), { raw: { width: 160, height: 120, channels: 3 } }).gif().toBuffer()),
  },
  {
    id: 'A5',
    group: 'A 类型说谎',
    file: 'A5-UPPER-CASE.PNG',
    title: '大写扩展名 .PNG，字节是 JPEG',
    symptom: '同上（大小写不应改变判定）',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'relabel', changed: true, mediaType: 'image/jpeg' },
    make: async (sharp) => makeImage(sharp, 200, 150, 'jpeg', 3),
  },
  {
    id: 'A6',
    group: 'A 类型说谎',
    file: 'A6-no-extension',
    title: '完全没有扩展名，字节是 JPEG（浏览器声明为空）',
    symptom: '报「仅支持…」或无法识别类型',
    declared: '',
    guiBlocked: '客户端 isImageMediaType(file.type) 严格四类，空类型不进图片链路',
    expect: { admission: 'accept', action: 'relabel', changed: true, mediaType: 'image/jpeg' },
    make: async (sharp) => makeImage(sharp, 200, 150, 'jpeg', 3),
  },
  {
    id: 'A7',
    group: 'A 类型说谎',
    file: 'A7-fake-png-real-avif.png',
    title: 'AVIF 字节，扩展名 .png（iPhone/新浏览器常见）',
    symptom: '报「仅支持 PNG、JPG、WebP、GIF 格式的图片」',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'convert', changed: true, mediaType: ['image/jpeg', 'image/webp'] },
    make: async (sharp) => {
      const raw = noise(240, 180, 3)
      return Buffer.from(await sharp(raw, { raw: { width: 240, height: 180, channels: 3 } }).avif({ quality: 60 }).toBuffer())
    },
  },
  {
    id: 'A8',
    group: 'A 类型说谎',
    file: 'A8-fake-png-real-tiff.png',
    title: 'TIFF 字节，扩展名 .png（扫描仪/传真）',
    symptom: '报「仅支持 PNG、JPG、WebP、GIF 格式的图片」',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'convert', changed: true, mediaType: ['image/jpeg', 'image/webp'] },
    make: async (sharp) => makeImage(sharp, 240, 180, 'tiff'),
  },
  {
    id: 'A10',
    group: 'A 类型说谎',
    file: 'A10-fake-png-real-svg.png',
    title: 'SVG 矢量图，扩展名 .png（网页另存）',
    symptom: '报「仅支持 PNG、JPG、WebP、GIF 格式的图片」',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'convert', changed: true, mediaType: ['image/jpeg', 'image/webp', 'image/png'] },
    make: async () => encodeSvg(),
  },
  {
    id: 'A11',
    group: 'A 类型说谎',
    file: 'A11-fake-png-exif-rotated.png',
    title: 'JPEG 带 EXIF 方向 6（竖拍手机照），扩展名 .png',
    symptom: '同上，且修好后方向必须正确',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'relabel', changed: true, mediaType: 'image/jpeg', bytesUnchanged: true },
    make: async (sharp) =>
      Buffer.from(
        await sharp(noise(300, 200, 3), { raw: { width: 300, height: 200, channels: 3 } })
          .jpeg({ quality: q })
          .withMetadata({ orientation: 6 })
          .toBuffer(),
      ),
  },

  // ── B. 超限：应「重编码到限内」 ─────────────────────────────────────────
  {
    id: 'B1',
    group: 'B 超限修复',
    file: 'B1-over-20mb.png',
    title: '24 MB PNG（超单图 20 MiB）',
    symptom: '报「单张图片不能超过 20MB」',
    declared: 'image/png',
    heavy: true,
    guiBlocked: '客户端 file.size > maxImageBytes 直接拦下（提示「单张图片不能超过 20MB」），到不了宿主',
    expect: { admission: 'accept', action: 'transcode', changed: true, maxBytes: 20 * 1024 * 1024, mediaType: ['image/jpeg', 'image/webp'] },
    make: async (sharp) => makeImage(sharp, 3300, 2500, 'png'),
  },
  {
    id: 'B2',
    group: 'B 超限修复',
    file: 'B2-over-64mp.png',
    title: '8192×8000 = 6553.6 万像素（超 6400 万像素上限）',
    symptom: '报「图片分辨率过大，请压缩后重试」',
    declared: 'image/png',
    heavy: true,
    expect: { admission: 'accept', action: 'transcode', changed: true, maxPixels: 64_000_000, longEdge: 8192 },
    make: async (sharp) => solid(sharp, 8192, 8000, 'png'),
  },
  {
    id: 'B3',
    group: 'B 超限修复',
    file: 'B3-over-8192-wide.png',
    title: '12000×100 长条（单边超 8192）',
    symptom: '报「图片宽高不能超过 8192px…」',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'transcode', changed: true, longEdge: 8192 },
    make: async (sharp) => solid(sharp, 12000, 100, 'png'),
  },
  {
    id: 'B4',
    group: 'B 超限修复',
    file: 'B4-over-8192-tall.png',
    title: '100×15000 长截图（单边超 8192）',
    symptom: '报「图片宽高不能超过 8192px…」',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'transcode', changed: true, longEdge: 8192 },
    make: async (sharp) => solid(sharp, 100, 15000, 'png'),
  },
  {
    id: 'B5',
    group: 'B 超限修复',
    file: 'B5-alpha-over-20mb.png',
    title: '2500×2500 带透明通道 PNG（超 20 MiB）',
    symptom: '报「单张图片不能超过 20MB」',
    declared: 'image/png',
    heavy: true,
    guiBlocked: '客户端 file.size > maxImageBytes 直接拦下（提示「单张图片不能超过 20MB」），到不了宿主',
    expect: { admission: 'accept', action: 'transcode', changed: true, maxBytes: 20 * 1024 * 1024, hasAlpha: true, mediaType: 'image/webp' },
    make: async (sharp) => makeImage(sharp, 2500, 2500, 'png', 4),
  },

  // ── C. 修不好：必须仍然是原来的错误 ─────────────────────────────────────
  {
    id: 'C1',
    group: 'C 应当仍然失败',
    file: 'C1-truncated-png.png',
    title: '真 PNG 被截断（传输中断）',
    symptom: '报「仅支持 PNG、JPG、WebP、GIF 格式的图片」（行为不应改变）',
    declared: 'image/png',
    expect: { admission: 'reject', code: 'INVALID_IMAGE', changed: false },
    make: async (sharp) => {
      const full = Buffer.from(await makeImage(sharp, 800, 600, 'png'))
      return full.subarray(0, Math.floor(full.length * 0.45))
    },
  },
  {
    id: 'C2',
    group: 'C 应当仍然失败',
    file: 'C2-text-renamed.png',
    title: '纯文本改名 .png',
    symptom: '报「仅支持…」（行为不应改变）',
    declared: 'image/png',
    expect: { admission: 'reject', code: 'INVALID_IMAGE', changed: false },
    make: async () => Buffer.from('这不是图片，只是一段文字。\nnot an image at all.\n', 'utf8'),
  },
  {
    id: 'C3',
    group: 'C 应当仍然失败',
    file: 'C3-empty.png',
    title: '0 字节文件（下载失败）',
    symptom: '报「仅支持…」（行为不应改变）',
    declared: 'image/png',
    expect: { admission: 'reject', code: 'INVALID_IMAGE', changed: false },
    make: async () => Buffer.alloc(0),
  },
  {
    id: 'C4',
    group: 'C 应当仍然失败',
    dir: true,
    file: 'C4-25-images',
    title: '25 张完全合规的小图（超 20 张上限）',
    symptom: '报数量超限——插件不会偷偷丢图',
    expect: { admission: 'reject', code: 'TOO_MANY_IMAGES', count: 25, changedCount: 0 },
    make: async (sharp) => {
      const shared = await makeImage(sharp, 32, 32, 'png')
      const files = {}
      for (let index = 1; index <= 25; index += 1) files[`img-${String(index).padStart(2, '0')}.png`] = shared
      return files
    },
  },

  {
    id: 'C5',
    group: 'C 应当仍然失败',
    file: 'C5-bmp-renamed.png',
    title: 'BMP 字节改名 .png（内置 libvips 没有 BMP 解码器）',
    symptom: '报「仅支持 PNG、JPG、WebP、GIF 格式的图片」——这类文件插件也无能为力',
    declared: 'image/png',
    expect: { admission: 'reject', code: 'INVALID_IMAGE', changed: false },
    make: async () => encodeBmp24(160, 120),
  },

  // ── D. 回归：完全合规的输入必须零改动 ───────────────────────────────────
  {
    id: 'D1',
    group: 'D 不误伤',
    file: 'D1-clean.png',
    title: '干净 PNG（对照组）',
    symptom: '本来就正常',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'none', changed: false, bytesUnchanged: true },
    make: async (sharp) => makeImage(sharp, 200, 150, 'png'),
  },
  {
    id: 'D2',
    group: 'D 不误伤',
    file: 'D2-clean.jpg',
    title: '干净 JPEG（对照组）',
    symptom: '本来就正常',
    declared: 'image/jpeg',
    expect: { admission: 'accept', action: 'none', changed: false, bytesUnchanged: true },
    make: async (sharp) => makeImage(sharp, 200, 150, 'jpeg', 3),
  },
  {
    id: 'D3',
    group: 'D 不误伤',
    file: 'D3-animated.gif',
    title: '两帧动图（合规；插件零改动，但 DSH 落库仍会压成单帧）',
    symptom: '本来就正常；上传后仍应会动',
    declared: 'image/gif',
    expect: { admission: 'accept', action: 'none', changed: false, pages: 2 },
    make: async () => encodeAnimatedGif(),
  },
  {
    id: 'D4',
    group: 'D 不误伤',
    file: 'D4-cmyk.jpg',
    title: 'CMYK JPEG（印刷厂/扫描仪输出）',
    symptom: '本来就正常；不应被插件误判',
    declared: 'image/jpeg',
    expect: { admission: 'accept', action: 'none', changed: false },
    make: async (sharp) =>
      Buffer.from(
        await sharp(noise(240, 180, 3), { raw: { width: 240, height: 180, channels: 3 } })
          .toColourspace('cmyk')
          .jpeg({ quality: q })
          .toBuffer(),
      ),
  },
  {
    id: 'D5',
    group: 'D 不误伤',
    file: 'D5-deep-color-16bit.png',
    title: '16 位深 PNG（HDR 截图/专业导出）',
    symptom: '本来就正常；应由上游归一化成 8-bit',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'none', changed: false },
    make: async () => encodePng16(64, 64),
  },
  {
    id: 'D6',
    group: 'D 不误伤',
    file: 'D6-alpha-small.png',
    title: '带透明通道的小 PNG（合规）',
    symptom: '本来就正常；透明度必须保留',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'none', changed: false, hasAlpha: true },
    make: async (sharp) => makeImage(sharp, 200, 150, 'png', 4),
  },
  {
    id: 'D7',
    group: 'D 不误伤',
    dir: true,
    file: 'D7-batch-mixed',
    title: '一次拖 5 张混合图（顺序、各自修复、互不影响）',
    symptom: '以前整批被其中一张拖垮',
    expect: { admission: 'accept', count: 5, changedCount: 3, order: ['a-fake.png', 'b-clean.png', 'c-webp.png', 'd-tiff.png', 'e-anim.gif'] },
    make: async (sharp) => ({
      'a-fake.png': await makeImage(sharp, 120, 90, 'jpeg'),
      'b-clean.png': await makeImage(sharp, 120, 90, 'png'),
      'c-webp.png': await makeImage(sharp, 120, 90, 'webp'),
      'd-tiff.png': await makeImage(sharp, 120, 90, 'tiff'),
      'e-anim.gif': encodeAnimatedGif(),
    }),
  },

  // ── N. 文件名边界（Windows 中文路径、空格、长名） ──────────────────────
  {
    id: 'N1',
    group: 'N 文件名',
    file: '中文名称-假PNG.png',
    title: '中文文件名 + 中文目录，字节是 JPEG',
    symptom: '以前报「仅支持…」',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'relabel', changed: true, mediaType: 'image/jpeg' },
    make: async (sharp) => makeImage(sharp, 160, 120, 'jpeg', 3),
  },
  {
    id: 'N2',
    group: 'N 文件名',
    file: 'name with spaces & (symbols)!.png',
    title: '空格与符号文件名，字节是 WebP',
    symptom: '以前报「仅支持…」',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'relabel', changed: true, mediaType: 'image/webp' },
    make: async (sharp) => makeImage(sharp, 160, 120, 'webp'),
  },
  {
    id: 'N3',
    group: 'N 文件名',
    file: `${'long-'.repeat(18)}name.png`,
    title: '90 字符长文件名，字节是 JPEG',
    symptom: '以前报「仅支持…」；显示名不应乱码',
    declared: 'image/png',
    expect: { admission: 'accept', action: 'relabel', changed: true, mediaType: 'image/jpeg' },
    make: async (sharp) => makeImage(sharp, 160, 120, 'jpeg', 3),
  },
]

/**
 * @param {string} file fixture filename.
 * @returns {string} human group of the case owning this file.
 */
export function groupOfFile(file) {
  const owner = CASES.find((entry) => entry.file === file || entry.file.endsWith(`/${file}`))
  return owner?.group ?? ''
}
