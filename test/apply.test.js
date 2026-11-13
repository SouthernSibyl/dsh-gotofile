/**
 * dsh-GotoFile — 宿主挂载冒烟测试
 *
 * 用一个最小的假 ctx 跑一遍 apply()：session/event → 登记簿 → /check → /open。
 * 目的不是替代 DSH，而是守住「插件挂载后会真的产出报告」这条主线：
 * 路由注册、事件订阅、子代理归属、白名单判定任何一处断了，这里都会红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

const jsonReq = (body) => {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.headers = {
    host: '127.0.0.1:19387',
    origin: 'http://127.0.0.1:19387',
    'content-type': 'application/json',
  }
  return req
}

const fakeRes = () => {
  const res = {
    status: null,
    body: null,
    destroyed: false,
    writableEnded: false,
    writeHead(status) { res.status = status },
    end(text) { res.body = JSON.parse(String(text)); res.writableEnded = true },
  }
  return res
}

/** 最小 ctx：只实现插件用到的那几个面 */
function fakeCtx(services) {
  const listeners = new Map()
  const routes = new Map()
  const ctx = {
    sessions: services.sessions,
    on(event, fn) {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
    },
    get(name) { return services[name] },
    inject(deps, cb) { if (deps.includes('webServer') && services.webServer !== undefined) cb(ctx) },
    effect(fn) { return fn() },
    fiber: { entry: { options: { id: 'goto-file' } } },
  }
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  }
  services.webServer = webServer
  const emit = (event, payload) => {
    for (const fn of listeners.get(event) ?? []) fn(...payload)
  }
  return { ctx, routes, emit, services }
}

const session = (id, cwd, extra = {}) => ({
  id,
  header: { id, cwd, origin: 'user', delegationDepth: 0, ...extra },
})

const call = (name, args, callId, turn) => ({
  type: 'tool/call',
  data: { turn, step: 1, callId, name, arguments: JSON.stringify(args) },
})
const result = (callId, turn) => ({
  type: 'tool/result',
  data: { turn, step: 1, toolCallId: callId, message: { role: 'tool', toolCallId: callId, isError: false } },
})

test('apply：run_code 里拼出来的 HTML 会进 /check 报告', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gotofile-'))
  try {
    const file = join(dir, 'site', 'index.html')
    const { ctx, routes, emit, services } = fakeCtx({
      sessions: { get: () => parent, list: () => [parent] },
    })
    const parent = session('s1', dir)
    services.sessions.get = () => parent
    apply(ctx, {})

    const code = [
      'const WB = ' + JSON.stringify(dir) + ';',
      'await tools.write({ file_path: WB + "/site/index.html", content: "<html></html>" });',
    ].join('\n')
    emit('session/event', [parent, call('run_code', { code }, 'c1', 3)])
    emit('session/event', [parent, result('c1', 3)])

    const res = fakeRes()
    await routes.get('/api/goto-file/check')(jsonReq({ sessionId: 's1', turn: 3 }), res)
    assert.equal(res.status, 200)
    assert.equal(res.body.files.length, 1)
    assert.equal(res.body.files[0].abs, file)
    assert.equal(res.body.files[0].name, 'index.html')
    assert.equal(res.body.files[0].op, 'new')
    assert.equal(res.body.files[0].probeable, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('apply：子代理写的文件挂到父会话当前轮', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gotofile-'))
  try {
    const parent = session('p1', dir)
    const child = session('c1', dir, { origin: 'subagent', delegationDepth: 1, parentSession: 'p1' })
    const { ctx, routes, emit, services } = fakeCtx({
      sessions: { get: () => parent, list: () => [parent, child] },
    })
    services.sessions.get = () => parent
    apply(ctx, {})

    emit('session/event', [parent, call('edit', { file_path: 'a.md', old_string: 'x', new_string: 'y' }, 'p-call', 5)])
    emit('session/event', [parent, result('p-call', 5)])
    // 子代理自己的轮次号是 1，不能落到父会话第 1 轮
    emit('session/event', [child, call('write', { file_path: 'out/page.html' }, 'k1', 1)])
    emit('session/event', [child, result('k1', 1)])

    const res = fakeRes()
    await routes.get('/api/goto-file/check')(jsonReq({ sessionId: 'p1', turn: 5 }), res)
    assert.deepEqual(res.body.files.map((file) => file.name), ['a.md', 'page.html'])
    assert.equal(res.body.files[1].op, 'new')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('apply：present 交付清单 + 跨盘路径可打开', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gotofile-'))
  const outside = await mkdtemp(join(tmpdir(), 'gotofile-outside-'))
  try {
    const htmlPath = join(outside, 'report.html')
    await writeFile(htmlPath, '<html></html>', 'utf8')
    const parent = session('p2', dir)
    const { ctx, routes, emit, services } = fakeCtx({
      sessions: { get: () => parent, list: () => [parent] },
    })
    services.sessions.get = () => parent
    apply(ctx, {})

    emit('session/event', [parent, call('present', { files: [{ path: htmlPath, description: '预览' }] }, 'x1', 2)])
    emit('session/event', [parent, result('x1', 2)])

    const res = fakeRes()
    await routes.get('/api/goto-file/check')(jsonReq({ sessionId: 'p2', turn: 2 }), res)
    const row = res.body.files[0]
    assert.equal(row.name, 'report.html')
    // 临时目录在 AppData 下（家目录敏感目录），默认不可打开；但它是本会话登记过的产物 → 放行
    assert.equal(row.probeable, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
