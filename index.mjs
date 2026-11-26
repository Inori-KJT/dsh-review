/**
 * 插件入口的薄包装。
 *
 * 存在它的唯一理由：宿主以 `main` 加载模块，而 .mjs 一定被当作 ESM 处理，
 * 不必依赖宿主对 .ts 是否做类型剥离的行为。真正的实现都在 src/index.ts。
 *
 * 注意：本文件是 .mjs，禁止任何 TypeScript 语法——包括 `export type`。
 */
export { name, inject, apply } from './src/index.ts'
