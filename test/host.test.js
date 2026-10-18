/**
 * dsh-GotoFile Host 半 — 单元测试（node --test，零依赖）
 *
 * 覆盖：工具调用 → 被改动路径的映射、call/result 配对与失败丢弃、
 *       new/edit 判定、单轮上限、官方摘要补漏去重、路径安全口径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'

import {
  parseArgs,
  mutationOf,
  candidateAbs,
  displayPath,
  isWithin,
  isProbeable,
  isSameOrigin,
  isJsonRequest,
  normalizeRoots,
  newRecorder,
  recordPath,
  onSessionEvent,
  assembleReport,
  Config,
} from '../lib/index.js'

/** 模拟平台路径拼接（测试跨平台可跑） */
const join = (...parts) => parts.join(sep)
const CWD = resolve(process.cwd())

// ── 参数解析 ──────────────────────────────────────────────────────────────

test('parseArgs 接受 JSON 字符串与对象，坏输入返回 undefined', () => {
  assert.deepEqual(parseArgs('{"a":1}'), { a: 1 })
  assert.deepEqual(parseArgs({ a: 1 }), { a: 1 })
  assert.equal(parseArgs('not json'), undefined)
  assert.equal(parseArgs(null), undefined)
  assert.equal(parseArgs(42), undefined)
})

// ── 写类工具 → 路径 ───────────────────────────────────────────────────────

test('mutationOf: write 是声明新建', () => {
  assert.deepEqual(mutationOf('write', { file_path: 'a/b.txt' }), { paths: ['a/b.txt'], declaredNew: true })
})

test('mutationOf: edit 用 old_string 是否为空区分新建', () => {
  assert.deepEqual(mutationOf('edit', { file_path: 'a.txt', old_string: '', new_string: 'x' }), { paths: ['a.txt'], declaredNew: true })
  assert.deepEqual(mutationOf('edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' }), { paths: ['a.txt'], declaredNew: false })
})

test('mutationOf: str_replace_editor 只认 create/str_replace/insert', () => {
  assert.equal(mutationOf('str_replace_editor', { command: 'view', path: 'a.txt' }), null)
  assert.deepEqual(mutationOf('str_replace_editor', { command: 'create', path: 'a.txt' }), { paths: ['a.txt'], declaredNew: true })
  assert.deepEqual(mutationOf('str_replace_editor', { command: 'str_replace', path: 'a.txt' }), { paths: ['a.txt'], declaredNew: false })
})

test('mutationOf: ops_replace 收具体路径，glob 模式不登记', () => {
  // glob 里的 `*.ts` 是模式不是路径：登记进去会在报告里变成「（已不存在）」的伪路径
  assert.deepEqual(
    mutationOf('ops_replace', { path: 'src/a.ts', pattern: 'a', replacement: 'b', glob: ['*.ts', '!*.test.ts', 'lib/a.ts'] }),
    { paths: ['src/a.ts', 'lib/a.ts'], declaredNew: false },
  )
  assert.equal(mutationOf('ops_replace', { glob: ['**/*.js'] }), null, '只有模式、没有具体路径 → 不登记')
  for (const name of ['ops_bash', 'ops_grep', 'ops_glob', 'ops_inspect_local_file', 'present', undefined]) {
    assert.equal(mutationOf(name, { file_path: 'a.txt' }), null, String(name))
  }
})

// ── call / result 配对 ────────────────────────────────────────────────────

const toolCall = (name, args, callId, turn) => ({
  type: 'tool/call',
  data: { turn, step: 1, callId, name, arguments: JSON.stringify(args) },
})
const toolResult = (callId, isError, turn) => ({
  type: 'tool/result',
  data: { turn, step: 1, toolCallId: callId, message: { role: 'tool', toolCallId: callId, isError } },
})

test('成功的 write 被登记为 new，失败的 write 一律丢弃', () => {
  const rec = newRecorder(CWD)
  onSessionEvent(rec, toolCall('write', { file_path: 'ok.txt' }, 'c1', 1), 200)
  onSessionEvent(rec, toolResult('c1', false, 1), 200)
  onSessionEvent(rec, toolCall('write', { file_path: 'bad.txt' }, 'c2', 1), 200)
  onSessionEvent(rec, toolResult('c2', true, 1), 200)
  const list = rec.turns.get(1)
  assert.equal(list.length, 1)
  assert.equal(list[0].abs, join(CWD, 'ok.txt'))
  assert.equal(list[0].op, 'new')
})

test('没有对应 result 的调用不登记（只读/流中未结算）', () => {
  const rec = newRecorder(CWD)
  onSessionEvent(rec, toolCall('write', { file_path: 'pending.txt' }, 'c9', 1), 200)
  assert.equal(rec.turns.size, 0)
  assert.equal(rec.pending.size, 1)
})

test('同一文件先 write 后 edit：第一次 new，第二次 edit 且不重复', () => {
  const rec = newRecorder(CWD)
  onSessionEvent(rec, toolCall('write', { file_path: 'same.txt' }, 'a', 1), 200)
  onSessionEvent(rec, toolResult('a', false, 1), 200)
  onSessionEvent(rec, toolCall('edit', { file_path: 'same.txt', old_string: '', new_string: 'x' }, 'b', 2), 200)
  onSessionEvent(rec, toolResult('b', false, 2), 200)
  assert.equal(rec.turns.get(1)[0].op, 'new')
  assert.equal(rec.turns.get(2)[0].op, 'edit', 'known 已吸收该路径 → 第二次是修改')
  assert.equal(rec.turns.get(2).length, 1)
})

test('单轮上限生效', () => {
  const rec = newRecorder(CWD)
  for (let i = 0; i < 5; i += 1) recordPath(rec, 1, 'f' + i + '.txt', true, 3)
  assert.equal(rec.turns.get(1).length, 3)
})

test('相对路径按登记器 cwd 解析', () => {
  const rec = newRecorder(join(CWD, 'nested'))
  recordPath(rec, 1, 'a.txt', true, 200)
  assert.equal(rec.turns.get(1)[0].abs, join(CWD, 'nested', 'a.txt'))
})

// ── 报告组装 ──────────────────────────────────────────────────────────────

test('官方摘要补漏并去重，补漏项算修改', () => {
  const rec = newRecorder(CWD)
  recordPath(rec, 3, 'mine.txt', true, 200)
  const files = assembleReport(rec, CWD, 3, ['mine.txt', 'from-git.txt'])
  assert.equal(files.length, 2)
  assert.equal(files[0].name, 'mine.txt')
  assert.equal(files[0].op, 'new')
  assert.equal(files[1].name, 'from-git.txt')
  assert.equal(files[1].op, 'edit')
  assert.equal(files[1].exists, false, '测试文件不存在 → 界面会置灰')
})

test('无登记器时只报官方摘要', () => {
  const files = assembleReport(undefined, CWD, 1, ['x/y.txt'])
  assert.equal(files.length, 1)
  assert.equal(files[0].abs, join(CWD, 'x', 'y.txt'))
})

test('display 在 cwd 内是正斜杠相对路径，cwd 外是绝对路径', () => {
  const inside = join(CWD, 'a', 'b.txt')
  assert.equal(displayPath(inside, CWD), 'a/b.txt')
  assert.equal(displayPath('Z:' + sep + 'elsewhere' + sep + 'c.txt', CWD), 'Z:' + sep + 'elsewhere' + sep + 'c.txt')
})

// ── 路径安全 ──────────────────────────────────────────────────────────────

test('candidateAbs 处理绝对路径、相对路径与 ~/、~\\', () => {
  assert.equal(candidateAbs('rel.txt', CWD), join(CWD, 'rel.txt'))
  assert.equal(candidateAbs(join(CWD, 'abs.txt'), CWD), join(CWD, 'abs.txt'))
  assert.equal(candidateAbs('~/notes.txt', CWD), join(homedir(), 'notes.txt'))
  // Windows 习惯写法（资源管理器复制出来的就是反斜杠）
  assert.equal(candidateAbs('~' + sep + 'notes.txt', CWD), join(homedir(), 'notes.txt'))
  assert.equal(candidateAbs('', CWD), '')
  assert.equal(candidateAbs('rel.txt', ''), '')
})

test('isWithin 不把 /a/bc 当成 /a/b 的子路径', () => {
  const base = join(CWD, 'a', 'b')
  assert.equal(isWithin(base, join(base, 'c.txt')), true)
  assert.equal(isWithin(base, base), true)
  assert.equal(isWithin(base, join(CWD, 'a', 'bc', 'c.txt')), false)
  assert.equal(isWithin(base, join(CWD, 'other.txt')), false)
})

test('isWithin 认盘根（白名单写 D:\\ 时不能失效）', () => {
  // 回归：旧实现手工去尾分隔符，把 'C:\' 裁成 'C:'，分隔符随之判成 '/'，盘根永远不匹配
  const root = process.platform === 'win32' ? CWD.slice(0, 2) + sep : '/'
  assert.equal(isWithin(root, join(root, 'any', 'deep', 'a.md')), true)
  assert.equal(isWithin(root, root), true)
  if (process.platform === 'win32') {
    assert.equal(isWithin('C:\\', 'C:\\a\\b.md'), true, '带尾斜杠的盘根也要认')
    assert.equal(isWithin('C:\\', 'D:\\a\\b.md'), false, '跨盘符不是子路径')
  }
})

test('isWithin 在大小写不敏感平台按大小写不敏感比较', () => {
  if (process.platform !== 'win32') {
    // 类 Unix 上大小写不同就是不同路径，这条断言反过来固化语义
    assert.equal(isWithin('/Users/A', '/users/a/b.txt'), false)
    return
  }
  assert.equal(isWithin(CWD, CWD.toLowerCase() + '\\a.txt'), true)
  assert.equal(isWithin(CWD.toUpperCase(), join(CWD, 'a.txt')), true)
})

test('isProbeable：cwd 内与家目录内放行，白名单根控权，越界拒绝', async () => {
  const cwd = join(CWD, 'work')
  assert.equal(isProbeable(join(cwd, 'a.txt'), cwd, []), true)
  assert.equal(isProbeable(join(homedir(), 'a.txt'), cwd, []), true)

  // 家目录之外的真实目录：白名单必须命中、且根下不得有系统盘特征目录
  const foreignRoot = process.platform === 'win32' ? 'C:' + sep + 'dsh-goto-file-probe' : '/tmp/dsh-goto-file-probe'
  await mkdir(foreignRoot, { recursive: true })
  const probeFile = join(foreignRoot, 'probe.txt')
  await writeFile(probeFile, 'probe\n', 'utf8')
  try {
    assert.equal(isWithin(homedir(), probeFile), false, '样本必须在家目录外，否则本用例无意义')
    assert.equal(isProbeable(probeFile, cwd, []), false, '无白名单 → 拒绝')
    assert.equal(isProbeable(probeFile, cwd, [foreignRoot]), true, '白名单根内 → 放行')
    assert.equal(isProbeable(probeFile, cwd, [join(resolve(CWD, '..'), 'binary-farm')]), false, '同级目录不是祖先 → 拒绝')
  } finally {
    await rm(foreignRoot, { recursive: true, force: true })
  }
})

test('isProbeable：家目录里的凭据目录默认拒绝，显式白名单才放行', () => {
  const cwd = join(CWD, 'work')
  const plain = join(homedir(), 'notes.txt')
  assert.equal(isProbeable(plain, cwd, []), true, '家目录普通文件默认放行')

  // 这几个目录里是登录态/私钥/明文 token，交给系统默认程序打开等于交出账号
  const sensitive = process.platform === 'win32'
    ? [join(homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cookies'),
       join(homedir(), '.ssh', 'id_rsa')]
    : [join(homedir(), '.ssh', 'id_rsa'), join(homedir(), '.npmrc')]
  for (const abs of sensitive) {
    assert.equal(isWithin(homedir(), abs), true, '样本必须在家目录内，否则本用例无意义')
    assert.equal(isProbeable(abs, cwd, []), false, '敏感目录默认拒绝: ' + abs)
  }
})

test('normalizeRoots：去空去重、~\\ 展开、盘根不被砍成盘符', () => {
  const raw = '/data/a'
  assert.deepEqual(
    normalizeRoots(['  ' + raw + '  ', raw, '', '~' + sep + 'd']),
    [resolve(raw), join(homedir(), 'd')],
  )
  if (process.platform === 'win32') {
    // 回归：'D:\' 经手工去尾分隔符会变成 'D:'（= D 盘当前目录），盘根白名单随后失效
    assert.deepEqual(normalizeRoots(['D:\\']), ['D:\\'])
    assert.deepEqual(normalizeRoots(['D:']), ['D:\\'], '只写盘符补成盘根')
    assert.deepEqual(normalizeRoots(['d:\\', 'D:\\']), ['D:\\'], '大小写不同视为同一个根')
  }
})

test('isSameOrigin：本机同端口放行，其他本地端口与外部域名拒绝', () => {
  const ok = (headers) => isSameOrigin({ headers })
  assert.equal(ok({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' }), true)
  assert.equal(ok({ host: 'localhost:19387', origin: 'http://localhost:19387' }), true)
  assert.equal(ok({ host: '127.0.0.1:19387', origin: 'http://localhost:19387' }), true, '同机同端口两种写法互认')
  assert.equal(ok({ host: '127.0.0.1:19387', origin: 'http://localhost:5173' }), false, '本地别的端口 = 别的源')
  assert.equal(ok({ host: '127.0.0.1:19387', origin: 'https://evil.example.com' }), false)
  assert.equal(ok({ host: '127.0.0.1:19387', origin: 'null' }), false)
  assert.equal(ok({ host: '127.0.0.1:19387' }), true, '无 Origin：同源 XHR / 非浏览器客户端')
  assert.equal(ok({ host: '[::1]:19387', origin: 'http://[::1]:19387' }), true, 'IPv6 回环')
  assert.equal(ok({ host: 'evil.example.com', origin: 'http://evil.example.com' }), false)
  // 宿主转发丢了 Host 时退回「Origin 是本机形态」的宽松判定，避免功能整体 403
  assert.equal(ok({ origin: 'http://127.0.0.1:19387' }), true, '缺 Host 但 Origin 是本机')
  assert.equal(ok({}), false)
})

test('isJsonRequest：只接受 JSON，挡掉免预检的 text/plain', () => {
  assert.equal(isJsonRequest({ headers: { 'content-type': 'application/json' } }), true)
  assert.equal(isJsonRequest({ headers: { 'content-type': 'application/json; charset=utf-8' } }), true)
  assert.equal(isJsonRequest({ headers: { 'content-type': 'application/vnd.api+json' } }), true)
  assert.equal(isJsonRequest({ headers: { 'content-type': 'text/plain' } }), false)
  assert.equal(isJsonRequest({ headers: { 'content-type': 'application/x-www-form-urlencoded' } }), false)
  assert.equal(isJsonRequest({ headers: {} }), false)
})

/**
 * 0.2.1-rc 起 cordis 的 resolveConfig 改读 Standard Schema：
 * `runtime.Config['~standard'].validate(config)`，且**必须是同步的**。
 * Config 只挂可执行函数的老形态在那边会抛
 *   TypeError: Cannot read properties of undefined (reading 'validate')
 * 整个 web boot 失败。旧宿主仍按 Config(config) 调，所以两副面孔都要守住。
 */
test('Config 同时支持 Standard Schema（0.2.1+）与函数形态（0.2.0）', async () => {
  const std = Config['~standard']
  assert.ok(std !== undefined, '缺少 ~standard：0.2.1+ 挂载会抛 reading validate of undefined')
  assert.equal(std.version, 1)
  const result = std.validate({})
  assert.equal(typeof result?.then, 'undefined', '~standard.validate 不能返回 Promise（宿主会拒绝）')
  assert.deepEqual(result.value, { extraProbeRoots: [], maxFilesPerTurn: 200 })
  assert.equal(std.validate({ maxFilesPerTurn: 5 }).value.maxFilesPerTurn, 5)
  assert.equal(std.validate(undefined).value.maxFilesPerTurn, 200)

  // 旧宿主：Config(config) 返回 Promise
  const legacy = await Config({})
  assert.equal(legacy.maxFilesPerTurn, 200)
})
