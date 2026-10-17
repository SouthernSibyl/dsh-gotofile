/**
 * dsh-GotoFile — 插件清单契约测试（node --test，零依赖）
 *
 * 为什么单独钉这一组：宿主半挂不上会立刻报错，浏览器半挂不上**完全不报错** ——
 * DSH 只读 `dsh.client` 决定要不要把这个包发给页面，字段缺失时它按「纯宿主插件」
 * 处理：/api/goto-file/* 路由都在，但对话结尾的文件报告和设置卡片永远不渲染，
 * 表现是「装上了却什么都没发生」。1.0.0 ~ 1.0.2 在仓库里一直缺这一段，本机是靠
 * 手工改过的 node_modules 才跑起来的，所以必须由测试守住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('dsh.client：浏览器半必须声明，否则页面侧静默不加载', () => {
  const client = pkg.dsh?.client
  assert.ok(client !== undefined, 'package.json 缺少 dsh.client（DSH 会当成纯宿主插件）')
  assert.equal(client.platform, 'web')
})

test('dsh.client.inject：必须是非空的包名数组', () => {
  const inject = pkg.dsh?.client?.inject
  assert.ok(Array.isArray(inject) && inject.length > 0, 'dsh.client.inject 必须是包名数组')
  for (const name of inject) {
    assert.equal(typeof name, 'string')
    assert.ok(name.startsWith('@deepseek-ai/dsh-'), `意外的注入依赖: ${name}`)
  }
})

test('exports["./client"] 指向真实存在的文件', () => {
  const rel = pkg.exports?.['./client']
  assert.equal(typeof rel, 'string')
  assert.ok(existsSync(join(root, rel)), `exports["./client"] 指向的文件不存在: ${rel}`)
  // 浏览器半是 window.__ModuleLoader__ bundle，不是 ESM 模块 —— 只断言入口标记存在
  const src = readFileSync(join(root, rel), 'utf8')
  assert.ok(src.includes('__ModuleLoader__'), 'client 入口缺少 __ModuleLoader__ 装载标记')
})

test('dsh.bundle.patch 存在，且 insert 的 name 与包名一致', () => {
  const patchRel = pkg.dsh?.bundle?.patch
  assert.equal(typeof patchRel, 'string')
  assert.ok(existsSync(join(root, patchRel)), `bundle patch 不存在: ${patchRel}`)
  const patch = readFileSync(join(root, patchRel), 'utf8')
  assert.ok(patch.includes(`name: ${pkg.name}`), `patch 里的 name 与包名不一致（应为 ${pkg.name}）`)
})

test('exports["./package.json"] 与 exports["."] 都在，宿主半入口存在', () => {
  assert.equal(pkg.exports?.['./package.json'], './package.json')
  const main = pkg.exports?.['.']
  assert.equal(typeof main, 'string')
  assert.ok(existsSync(join(root, main)), `宿主半入口不存在: ${main}`)
})
