/**
 * 结构测试：core 必须自足。
 *
 * 判据两条：
 *   1 不 import 任何 `node:*`（不许做 I/O）；
 *   2 不 import 任何 `@deepseek-ai/*`（不许依赖宿主）。
 * 这条测试本身在 tests 目录下，可以用 fs 读源码，不受上面两条约束。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CORE = join(import.meta.dirname, '..', 'src', 'core')

const files = readdirSync(CORE).filter(name => name.endsWith('.ts'))

test('core 至少有七个文件，避免测试空跑通过', () => {
  assert.ok(files.length >= 7, `core 只有 ${files.length} 个文件`)
})

for (const file of files) {
  test(`${file} 不 import node:*`, () => {
    const source = readFileSync(join(CORE, file), 'utf8')
    const offenders = [...source.matchAll(/from\s+['"]node:([^'"]+)['"]/g)].map(match => match[0])
    assert.deepEqual(offenders, [], `${file} 引入了 I/O 模块: ${offenders.join(', ')}`)
  })

  test(`${file} 不 import @deepseek-ai/*`, () => {
    const source = readFileSync(join(CORE, file), 'utf8')
    const offenders = [...source.matchAll(/from\s+['"]@deepseek-ai\/[^'"]+['"]/g)].map(match => match[0])
    assert.deepEqual(offenders, [], `${file} 依赖了宿主包: ${offenders.join(', ')}`)
  })

  test(`${file} 的相对 import 都带 .ts 后缀`, () => {
    const source = readFileSync(join(CORE, file), 'utf8')
    const bare = [...source.matchAll(/from\s+['"](\.[^'"]*)['"]/g)]
      .map(match => match[1])
      .filter(specifier => !specifier.endsWith('.ts'))
    assert.deepEqual(bare, [], `${file} 有裸相对 import: ${bare.join(', ')}`)
  })
}
