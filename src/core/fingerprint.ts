/**
 * 发现指纹。作用是判断"跨轮次是不是同一个问题"，不是安全用途。
 *
 * 指纹 v1 的公式：
 *   sha1(路径 + ':' + 所在符号名 + ':' + 类别 + ':' + 规范化代码 + ':' + 同一符号内的序号)
 *
 * 三处设计决定的理由：
 *   1 不含行号，所以行号偏移不改变指纹；这正是"修复后重新引入"能被认出的前提。
 *   2 含符号名与序号，所以同一文件里两处相同的代码片段不会合并成一条。
 *   3 公式封装在 FingerprintStrategy 接口后面，将来换模糊匹配只换实现。
 *
 * 这一层不 import 任何模块，SHA-1 自带实现，以保持 core 的零依赖与可单测。
 */
import type { Category } from './model.ts'

export interface FingerprintInput {
  path: string
  /** 所在函数或符号名；取不到时用空串。 */
  symbol: string
  category: Category
  /** 原始代码片段，规范化由本模块完成。 */
  code: string
  /** 同一符号内第几次出现，从 1 开始。 */
  ordinal: number
}

export interface FingerprintStrategy {
  readonly version: number
  of(input: FingerprintInput): string
}

/**
 * 代码规范化：去掉行尾空白、把连续空白折叠成一个空格、丢弃空行、
 * 丢弃纯注释行。保留行的顺序，因此语义相同的代码得到同一个结果。
 */
export function normalizeCode(code: string): string {
  return code
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !isCommentOnly(line))
    .map(line => line.replace(/\s+/g, ' '))
    .join('\n')
}

function isCommentOnly(line: string): boolean {
  if (line.startsWith('//')) return true
  if (line.startsWith('#')) return true
  if (line.startsWith('*')) return true
  if (line.startsWith('/*') && line.endsWith('*/')) return true
  return false
}

/** 指纹 v1。 */
export const fingerprintV1: FingerprintStrategy = {
  version: 1,
  of(input: FingerprintInput): string {
    const parts = [
      input.path.trim(),
      input.symbol.trim(),
      input.category,
      normalizeCode(input.code),
      String(input.ordinal),
    ]
    return sha1Hex(parts.join(':'))
  },
}

/** 当前生效的策略。换策略时改这一处，并把 version 升号。 */
export const currentFingerprint: FingerprintStrategy = fingerprintV1

/**
 * 纯 JS 的 UTF-8 编码。自带实现而不是用 TextEncoder，
 * 因为 TextEncoder 是宿主全局，core 要在任何运行时里都能跑。
 */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        i += 1
      }
    }
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
  }
  return new Uint8Array(out)
}

/** 纯 JS 的 SHA-1。只用于去重，不用于安全。 */
export function sha1Hex(message: string): string {
  const data = utf8Bytes(message)
  const bitLength = data.length * 8
  const blocks = Math.ceil((data.length + 1 + 8) / 64)
  const buffer = new Uint8Array(blocks * 64)
  buffer.set(data)
  buffer[data.length] = 0x80
  const view = new DataView(buffer.buffer)
  view.setUint32(buffer.length - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(buffer.length - 4, bitLength >>> 0, false)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)

  for (let block = 0; block < blocks; block += 1) {
    const offset = block * 64
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(offset + t * 4, false)
    for (let t = 16; t < 80; t += 1) {
      const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]
      w[t] = ((x << 1) | (x >>> 31)) >>> 0
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let t = 0; t < 80; t += 1) {
      let f: number
      let k: number
      if (t < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (t < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (t < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = ((((a << 5) | (a >>> 27)) >>> 0) + (f >>> 0) + e + k + w[t]) >>> 0
      e = d
      d = c
      c = ((b << 30) | (b >>> 2)) >>> 0
      b = a
      a = temp
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  return [h0, h1, h2, h3, h4].map(value => value.toString(16).padStart(8, '0')).join('')
}
