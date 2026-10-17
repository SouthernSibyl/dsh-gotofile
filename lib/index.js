/**
 * dsh-GotoFile — Host 半
 *
 * 本轮「产出 / 修改」文件登记簿 + 系统文件管理器定位路由。
 *
 * 数据来源（两层，按可靠性排序）：
 *   1. 本插件的登记器：订阅 `session/event`，把 `tool/call`（工具名 + 参数）
 *      与 `tool/result`（callId + isError）配对，只登记**成功**的写类工具调用；
 *      `tool/result` 流里没有对应结果或结果为错误的调用一律不计。
 *      - cwd 里没有同名文件 → op = 'new'；已有 → op = 'edit'。
 *      - `str_replace_editor` 的 command 直接给出 create/insert → 'new'。
 *   2. 官方 `workspaceChanges` 服务（可选注入）：`summary(sessionId, turn)`
 *      返回该轮的权威改动清单（文件工具编辑 + git 快照），把登记簿没覆盖到的
 *      路径（例如 `ops_bash` 重定向、git 检出）补进来。服务缺失/返回 undefined
 *      时静默降级，只上报登记簿的内容。
 *
 * 路由（全部 isSameOrigin 防本地 CSRF）：
 *   POST /api/goto-file/check   { sessionId, turn, paths? } → { files: [...] }
 *   POST /api/goto-file/open    { sessionId, path, mode }   → { ok }
 *        mode "reveal"（默认，双击）= 文件管理器中定位选中；"open" = 默认应用打开
 *   GET/POST /api/goto-file/config  { extraProbeRoots } 外置盘白名单读写
 *
 * 路径安全口径（沿用 dsh-file-mentions 的既有实现）：
 *   相对路径按会话 cwd 解析；绝对 / ~/ 路径必须落在会话 cwd 或本机主目录内，
 *   或落在用户显式声明的白名单根内（系统盘特征目录自动拒绝、symlink 防逃逸）。
 *   系统打开一律 execFile 直传参数，不经 shell。
 *
 * 纯 Node 实现，跨平台（win32 / darwin / linux 已按平台分流）。
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'

/** 请求体上限（防本地无鉴权端点被超大 body 打爆内存；正常请求远小于此） */
const MAX_BODY_BYTES = 100 * 1024

/** 待结算工具调用（等 tool/result 配对）的暂存上限 */
const MAX_PENDING_CALLS = 2000

/** 设置命名空间回落值（拿不到 profile 条目 id 时使用） */
const NS = 'goto-file'

export const name = 'dsh-GotoFile'
// 不静态依赖 'webServer'：它是 Web/桌面宿主才有的服务，headless 宿主没有；
// 静态声明会让插件在那种宿主里一直 pending。路由改为动态注入（见 apply 末尾）。
export const inject = ['sessions']

/*
 * schemastery 是 DSH 运行时自带的包（profile 的 node_modules 里必有），
 * 但本包也可以被单独克隆出来 —— 那种环境里 import 一个不存在的包会在
 * **加载阶段**就抛 ERR_MODULE_NOT_FOUND，连单测都起不来。
 * 所以这里不写静态 import：首次读取 Config 时才去解析真包。
 * cordis 读 Config 发生在挂载时（此时 DSH 运行时已在路径上），读不到就
 * 退回"无校验"形态，绝不因配置 schema 拖垮整个插件。
 */
let cachedSchema

async function loadSchema() {
  if (cachedSchema !== undefined) return cachedSchema
  try {
    const mod = await import('@deepseek-ai/schemastery')
    const real = mod?.default ?? mod
    if (real !== undefined && real !== null && typeof real.object === 'function') {
      cachedSchema = real
      return cachedSchema
    }
  } catch {
    // 脱离 DSH 环境（例如裸克隆跑单测）时静默退化
  }
  cachedSchema = {
    object: (shape) => (value) => {
      const out = {}
      for (const [key, field] of Object.entries(shape ?? {})) {
        out[key] = value !== undefined && value !== null && value[key] !== undefined ? value[key] : field?.default
      }
      return out
    },
  }
  return cachedSchema
}

/**
 * 配置 schema 的懒加载门面：cordis 读它时是真 schema，脱离 DSH 时是恒等形态。
 * 形如 `z.object({...})` 的调用被推迟到属性第一次被读取时。
 */
/** 配置字段形状（懒加载与恒等回落共用；改字段只需改这里） */
const SCHEMA_SHAPE = {
  /** 外置盘/网络盘白名单根（用户显式声明 = 授权；空 = 只放行会话 cwd 与主目录内） */
  extraProbeRoots: { default: [] },
  /** 单轮文件数上限（防病态轮次把注册表撑爆） */
  maxFilesPerTurn: { default: 200 },
}

/** 读一次 volatile 引用：新宿主给的是 { get() }，普通值/缺失时原样返回 */
function readRef(ref) {
  if (ref === undefined || ref === null) return undefined
  if (typeof ref.get === 'function') {
    try {
      return ref.get()
    } catch {
      return undefined
    }
  }
  return ref
}

/**
 * 恒等形态：把用户配置按 SCHEMA_SHAPE 归一化成 { 字段: 值或默认值 }。
 * 真 schema（DSH 环境）会做同样的事，所以这里只是脱离 DSH 时的替身。
 */
function normalizeConfig(value) {
  const source = value !== undefined && value !== null && typeof value === 'object' ? value : {}
  const out = {}
  for (const [key, field] of Object.entries(SCHEMA_SHAPE)) {
    const raw = source[key] !== undefined ? source[key] : readRef(field.default)
    out[key] = raw
  }
  return out
}

/** 真 schema 解析成功后缓存在这里；undefined = 还没试过 */
let configSchema

/**
 * 解析配置 schema：DSH 环境拿到真 schemastery，脱离 DSH 时拿到恒等形态。
 * 真包在挂载时一定可解析（它就是 DSH 运行时自带包）；万一解析失败也退回恒等形态，
 * 不因为配置校验拖垮整个插件。
 */
async function resolveConfigSchema() {
  if (configSchema !== undefined) return configSchema
  try {
    const mod = await import('@deepseek-ai/schemastery')
    const real = mod?.default ?? mod
    if (real !== undefined && real !== null && typeof real.object === 'function') {
      configSchema = real.object(SCHEMA_SHAPE)
      return configSchema
    }
  } catch {
    // 脱离 DSH 环境（例如裸克隆下跑单测）：静默退化
  }
  configSchema = (value) => normalizeConfig(value)
  return configSchema
}

/**
 * Config 用函数形态：cordis 挂载时会调它拿到真正的 schema（此刻 DSH 运行时已在路径上）。
 * 用函数而不是顶层 z.object(...)，是为了让本文件在「没有 schemastery 的裸克隆」里
 * 也能被 import —— 顶层静态 import 不存在的包会在加载阶段直接抛错，连单测都跑不起来。
 */
export function Config(value) {
  return resolveConfigSchema().then((schema) => schema(value ?? {}))
}

/** 测试/调试用：拿到解析后的 schema 本身 */
export async function configSchemaForTest() {
  return resolveConfigSchema()
}

export function apply(ctx, config) {
  const cfg = config ?? {}
  const sessions = ctx.sessions
  if (sessions === undefined) return

  // 读 volatile 引用：新宿主给的是 { get() }，普通值/缺失时原样返回
  const refValue = (ref) => {
    try {
      if (ref !== null && typeof ref === 'object' && typeof ref.get === 'function') return ref.get()
      return ref
    } catch (error) {
      return undefined
    }
  }
  const probeRoots = () => {
    const list = refValue(cfg.extraProbeRoots)
    return normalizeRoots(Array.isArray(list) ? list : [])
  }
  const maxFilesPerTurn = () => {
    const value = refValue(cfg.maxFilesPerTurn)
    return Number.isSafeInteger(value) && value > 0 ? value : 200
  }
  // 本插件在 profile 里的条目 id（设置写入按条目 id 定位；拿不到时回落 NS）
  const entryId = () => {
    try {
      const id = ctx.fiber && ctx.fiber.entry && ctx.fiber.entry.options ? ctx.fiber.entry.options.id : undefined
      return typeof id === 'string' && id !== '' ? id : NS
    } catch (error) {
      return NS
    }
  }
  const writeRoots = async (next) => {
    const settings = ctx.get('settings')
    if (!settings || typeof settings.update !== 'function') {
      throw new Error('settings 服务不可用（写配置需要 DSH >= 0.1.7）')
    }
    try {
      await settings.update(entryId(), { extraProbeRoots: next })
    } catch (error) {
      if (entryId() === NS) throw error
      await settings.update(NS, { extraProbeRoots: next })
    }
  }

  // 可选持久来源：相对路径解析兜底用（重启后未打开的冷会话不在活会话列表里）
  const workspaceRegistry = ctx.get('workspaceRegistry')
  const sessionPersistence = ctx.get('sessionPersistence')

  // ── 登记器（逻辑在模块级，可单测）────────────────────────────────────────
  // recorders: Map<session, rec>；rec = { cwd, turns: Map<turn, Candidate[]>, known: Set<string>, pending: Map<callId, pendingCall> }
  const recorders = new Map()

  /** 只登记顶层会话（子代理 / 委派产生的改动不属于本会话的报告） */
  const eligible = (session) => {
    const header = session && session.header
    if (header === undefined || header === null) return undefined
    const { cwd, origin, delegationDepth } = header
    if (origin === 'subagent' || (delegationDepth ?? 0) > 0) return undefined
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  }
  const recorderFor = (session, cwd) => {
    let rec = recorders.get(session)
    if (rec === undefined) {
      rec = newRecorder(cwd)
      recorders.set(session, rec)
    }
    return rec
  }

  ctx.on('session/event', (session, event) => {
    const headerCwd = eligible(session)
    if (headerCwd === undefined) return
    const rec = recorderFor(session, headerCwd)
    // 会话 cwd 可能迟于登记器创建才有值，顺手刷新
    rec.cwd = headerCwd
    onSessionEvent(rec, event, maxFilesPerTurn())
  })

  ctx.on('session/disposed', (session) => {
    recorders.delete(session)
  })

  /** 官方 workspaceChanges 摘要里该轮的路径（服务不可用/无记录时返回空数组） */
  const officialFiles = (sessionId, turn) => {
    try {
      const service = ctx.get('workspaceChanges')
      if (service === undefined || service === null || typeof service.summary !== 'function') return []
      const summary = service.summary(sessionId, turn)
      if (summary === undefined || summary === null || !Array.isArray(summary.files)) return []
      return summary.files
        .map((file) => (file && typeof file.path === 'string' ? file.path : ''))
        .filter((p) => p !== '')
    } catch (error) {
      return []
    }
  }

  /**
   * 一轮的报告条目：登记簿 + 官方摘要补并集（登记簿的顺序优先，官方补漏的追加在后）。
   * @returns {Array<{ name, abs, display, op, exists, isDir, outside }>}
   */
  const reportFor = (rec, cwd, turn, officialPaths) => assembleReport(rec, cwd, turn, officialPaths)

  // ── 路由注册（动态注入：headless 宿主没有 webServer 时整块跳过）────────────
  ctx.inject(['webServer'], (serverCtx) => {
    const webServer = serverCtx.webServer ?? (typeof serverCtx.get === 'function' ? serverCtx.get('webServer') : undefined)
    if (webServer === undefined || typeof webServer.register !== 'function') return

    // ── check：本轮报告（登记簿 ∪ 官方摘要，全部经存在性校验）──
    serverCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/goto-file/check',
      handler: async (req, res) => {
        try {
          if (!isSameOrigin(req)) {
            writeJson(res, 403, { files: [], error: 'forbidden: cross-origin request' })
            return
          }
          if (!isJsonRequest(req)) {
            writeJson(res, 415, { files: [], error: 'unsupported media type: application/json required' })
            return
          }
          const body = await readBody(req, MAX_BODY_BYTES)
          const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : null
          if (sessionId === null || sessionId === '') {
            writeJson(res, 200, { files: [] })
            return
          }
          // 会话必须真实存在才响应（杜绝无鉴权探测）
          const session = sessions.get(sessionId)
          if (session === undefined || session === null) {
            writeJson(res, 200, { files: [] })
            return
          }
          const turn = Number.isSafeInteger(body && body.turn) ? body.turn : Number(body && body.turn)
          if (!Number.isSafeInteger(turn)) {
            writeJson(res, 200, { files: [] })
            return
          }
          const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : ''
          const rec = recorders.get(session)
          if (rec !== undefined) rec.cwd = cwd
          const files = reportFor(rec, cwd, turn, officialFiles(sessionId, turn))
          writeJson(res, 200, { turn, files })
        } catch (error) {
          writeJson(res, 500, { files: [], error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'goto-file: check route')

    // ── open：系统文件管理器定位（双击）/ 默认应用打开 ──
    serverCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/goto-file/open',
      handler: async (req, res) => {
        try {
          if (!isSameOrigin(req)) {
            writeJson(res, 403, { ok: false, error: 'forbidden: cross-origin request' })
            return
          }
          if (!isJsonRequest(req)) {
            writeJson(res, 415, { ok: false, error: 'unsupported media type: application/json required' })
            return
          }
          const body = await readBody(req, MAX_BODY_BYTES)
          const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : null
          const path = body && typeof body.path === 'string' && body.path !== '' ? body.path : null
          const mode = body && body.mode === 'open' ? 'open' : 'reveal'
          if (sessionId === null || path === null) {
            writeJson(res, 400, { ok: false, error: 'sessionId 与 path 必填' })
            return
          }
          const session = sessions.get(sessionId)
          if (session === undefined || session === null) {
            writeJson(res, 400, { ok: false, error: '会话不存在' })
            return
          }
          const cwd = session && session.header && typeof session.header.cwd === 'string' ? session.header.cwd : null
          const extras = await durableCwds(workspaceRegistry, sessionPersistence)
          const abs = await resolveFirst(path, cwd, sessions, extras, probeRoots())
          if (abs === null) {
            writeJson(res, 404, { ok: false, error: '路径不存在或不在允许范围内: ' + path })
            return
          }
          const isDir = safeIsDir(abs)
          const result = await systemOpen(abs, isDir, mode === 'reveal')
          if (result !== null) {
            writeJson(res, 200, { ok: true, abs })
          } else {
            writeJson(res, 500, { ok: false, error: '系统打开命令执行失败（平台: ' + process.platform + '）' })
          }
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'goto-file: open route')

    // ── config：外置盘白名单读写（设置页用）──
    serverCtx.effect(() => webServer.register({
      kind: 'exact',
      path: '/api/goto-file/config',
      handler: async (req, res) => {
        try {
          if (!isSameOrigin(req)) {
            writeJson(res, 403, { ok: false, error: 'forbidden: cross-origin request' })
            return
          }
          if (req.method === 'GET' || req.method === 'HEAD') {
            writeJson(res, 200, { ok: true, extraProbeRoots: probeRoots() })
            return
          }
          if (req.method === 'POST' || req.method === 'PUT') {
            if (!isJsonRequest(req)) {
              writeJson(res, 415, { ok: false, error: 'unsupported media type: application/json required' })
              return
            }
            const body = await readBody(req, MAX_BODY_BYTES)
            const list = body && Array.isArray(body.extraProbeRoots)
              ? body.extraProbeRoots.filter((p) => typeof p === 'string' && p.trim() !== '')
              : []
            await writeRoots(normalizeRoots(list))
            writeJson(res, 200, { ok: true, extraProbeRoots: probeRoots() })
            return
          }
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'goto-file: config route')
  })
}

// ── 工具调用 → 被改动路径 ─────────────────────────────────────────────────

/** 宽松解析工具参数（JSON 字符串或对象） */
export function parseArgs(raw) {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return undefined
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch (error) {
    return undefined
  }
}

const PATH_KEYS = ['file_path', 'path', 'target', 'filename', 'file', 'abs_path', 'absPath']

/** 是否是一个 glob 模式（而不是具体路径） */
function isGlobPattern(value) {
  return /[*?[\]{}]/.test(value)
}

const textOf = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)

/**
 * 写类工具调用命中的路径与「是否声明为新建」。
 * 只认明确的写工具名；未知工具一律不登记（宁可漏报也不把只读调用当产物）。
 * @param {string} name 工具名
 * @param {object|undefined} args 已解析的参数
 * @returns {{paths: string[], declaredNew: boolean}|null}
 */
export function mutationOf(name, args) {
  if (args === null || args === undefined || typeof args !== 'object') return null
  switch (name) {
    case 'write':
      return { paths: [textOf(args.file_path)].filter(Boolean), declaredNew: true }
    case 'edit': {
      const path = textOf(args.file_path)
      if (path === undefined) return null
      // 空 old_string = 新建文件；有 old_string = 就地修改既有内容
      const declaredNew = typeof args.old_string === 'string' && args.old_string === ''
      return { paths: [path], declaredNew }
    }
    case 'str_replace_editor': {
      const path = textOf(args.path)
      if (path === undefined) return null
      const command = typeof args.command === 'string' ? args.command : ''
      if (command !== 'create' && command !== 'str_replace' && command !== 'insert') return null
      return { paths: [path], declaredNew: command === 'create' }
    }
    // dsh-ops 的机械替换工具（path + pattern + replacement）
    case 'ops_replace': {
      const paths = []
      if (typeof args.path === 'string') paths.push(args.path)
      // `glob` 里是**模式**不是路径（`src/*.ts`、`**/*.js`）：登记进去会在报告里变成一批
      // 「（已不存在）」的伪路径。这里只收具体路径，glob 命中的真实文件靠官方
      // workspaceChanges 快照补漏（那是权威清单，比自己展开模式更准）。
      if (Array.isArray(args.glob)) {
        for (const item of args.glob) {
          if (typeof item !== 'string' || item.startsWith('!') || isGlobPattern(item)) continue
          paths.push(item)
        }
      }
      return paths.length === 0 ? null : { paths, declaredNew: false }
    }
    default:
      return null
  }
}

// ── 登记器纯逻辑（模块级，可单测）──────────────────────────────────────────
// rec = { cwd, turns: Map<turn, Array<{raw, abs, op}>>, known: Set<string>, pending: Map<callId, pendingCall> }

/** 新建一个会话登记器 */
export function newRecorder(cwd) {
  return { cwd: typeof cwd === 'string' ? cwd : '', turns: new Map(), known: new Set(), pending: new Map() }
}

/**
 * 登记一个成功写类调用命中的路径。
 * op 判定：调用方声明新建（write / str_replace_editor create）且本会话此前未见过该路径 → 'new'，
 * 否则 'edit'。known 会吸收所有登记过的路径，因此同一文件第二次被写回就是 'edit'。
 */
export function recordPath(rec, turn, rawPath, declaredNew, maxPerTurn) {
  const max = Number.isSafeInteger(maxPerTurn) && maxPerTurn > 0 ? maxPerTurn : 200
  const raw = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (raw === '') return
  const abs = candidateAbs(raw, rec.cwd)
  if (abs === '') return
  const list = rec.turns.get(turn) ?? []
  if (list.length >= max) return
  if (list.some((item) => samePath(item.abs, abs))) return
  const op = declaredNew === true && !rec.known.has(abs) ? 'new' : 'edit'
  rec.known.add(abs)
  list.push({ raw, abs, op })
  rec.turns.set(turn, list)
}

/**
 * 处理一条会话事件：tool/call 暂存（调用 → 路径），tool/result 结算
 * （成功才登记，isError 的调用一律丢弃，工具流里没有结果的调用也不会被登记）。
 * 其他事件类型忽略。
 */
export function onSessionEvent(rec, event, maxPerTurn) {
  const type = event && event.type
  const data = (event && event.data) ?? {}
  if (type === 'tool/call') {
    const callId = data.toolCallId ?? data.callId
    if (typeof callId !== 'string' || callId === '') return
    const hit = mutationOf(data.name, parseArgs(data.arguments))
    if (hit === null) return
    // 结果永远不回来的调用（宿主异常、会话被掐断）会一直挂在 pending 里；
    // 超过上限就丢最老的一条，避免长会话缓慢吃内存
    if (rec.pending.size >= MAX_PENDING_CALLS) {
      const oldest = rec.pending.keys().next()
      if (oldest.done !== true) rec.pending.delete(oldest.value)
    }
    rec.pending.set(callId, { turn: data.turn, paths: hit.paths, declaredNew: hit.declaredNew })
    return
  }
  if (type === 'tool/result') {
    const callId = data.toolCallId ?? data.callId ?? (data.message && data.message.toolCallId)
    const pending = typeof callId === 'string' ? rec.pending.get(callId) : undefined
    if (pending === undefined) return
    rec.pending.delete(callId)
    const failed = data.message !== undefined && data.message !== null && data.message.isError === true
    if (failed) return
    for (const p of pending.paths) recordPath(rec, pending.turn, p, pending.declaredNew, maxPerTurn)
  }
}

/**
 * 组装一轮的报告条目：登记簿在前（保留登记顺序），官方摘要补漏的追加在后，按绝对路径去重。
 * 每个条目带上存在性、是否目录、是否在会话 cwd 之外。
 * @returns {Array<{ name, abs, display, op, exists, isDir, outside }>}
 */
export function assembleReport(rec, cwd, turn, officialPaths) {
  const entries = []
  const seen = new Set()
  const push = (raw, op) => {
    const abs = candidateAbs(raw, cwd)
    if (abs === '') return
    const key = normalizeKey(abs)
    if (seen.has(key)) return
    seen.add(key)
    entries.push({ abs, op: op === 'new' ? 'new' : 'edit' })
  }
  const recorded = rec === undefined || rec === null ? [] : rec.turns.get(turn) ?? []
  for (const item of recorded) push(item.abs, item.op)
  for (const raw of Array.isArray(officialPaths) ? officialPaths : []) push(raw, 'edit')

  return entries.map((item) => {
    const exists = safeExists(item.abs)
    const isDir = exists ? safeIsDir(item.abs) : false
    return {
      name: basename(item.abs),
      abs: item.abs,
      display: displayPath(item.abs, cwd),
      op: item.op,
      exists,
      isDir,
      outside: typeof cwd === 'string' && cwd !== '' && !isWithin(cwd, item.abs),
    }
  })
}

// ── 路径工具 ──────────────────────────────────────────────────────────────

/** 相对路径按 cwd 归一化；绝对 / ~/ 原样展开。返回绝对路径，空串表示无法解析 */
export function candidateAbs(raw, cwd) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') return ''
  if (value === '~') return homedir()
  // 两种家目录写法都认：`~/x`（类 Unix 习惯）与 `~\x`（Windows 习惯，资源管理器复制出来的就是这个）
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(homedir(), value.slice(2))
  if (isAbsolute(value)) return resolve(value)
  if (typeof cwd === 'string' && cwd !== '') return resolve(cwd, value)
  return ''
}

/** 大小写不敏感平台上的比较键（Windows 盘符/路径大小写不敏感） */
function normalizeKey(abs) {
  const canonical = process.platform === 'win32' ? abs.toLowerCase() : abs
  return canonical.split(sep).join('/')
}

function samePath(a, b) {
  return normalizeKey(a) === normalizeKey(b)
}

function safeExists(abs) {
  try {
    return existsSync(abs)
  } catch (error) {
    return false
  }
}

function safeIsDir(abs) {
  try {
    return statSync(abs).isDirectory()
  } catch (error) {
    return false
  }
}

/** 会话 cwd 内的相对路径（正斜杠）、cwd 外的绝对路径 */
export function displayPath(abs, cwd) {
  if (typeof cwd === 'string' && cwd !== '' && isWithin(cwd, abs)) {
    const rel = relative(cwd, abs)
    return rel === '' ? '.' : rel.split(sep).join('/')
  }
  return abs
}

/** 绝对路径原样（含 Windows 盘符）；~/ 展开；相对路径按会话 cwd 解析 */
function resolvePath(p, cwd) {
  const abs = candidateAbs(p, cwd)
  return abs === '' ? p : abs
}

/**
 * 收集持久化的相对路径解析基数：工作区注册表根目录 + 全部持久化会话的 cwd。
 * 任一来源不可用或抛错时静默降级，不影响主流程。
 */
async function durableCwds(workspaceRegistry, sessionPersistence) {
  const out = []
  const seen = new Set()
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !seen.has(value)) {
      seen.add(value)
      out.push(value)
    }
  }
  try {
    if (workspaceRegistry !== undefined && typeof workspaceRegistry.list === 'function') {
      for (const w of workspaceRegistry.list()) push(w && w.path)
    }
  } catch (error) {
    // 静默降级
  }
  try {
    if (sessionPersistence !== undefined && typeof sessionPersistence.list === 'function') {
      const headers = await sessionPersistence.list()
      for (const h of headers) push(h && h.cwd)
    }
  } catch (error) {
    // 静默降级
  }
  return out
}

/**
 * 规范化后 target 是否仍位于 base 之内（防 ../ 逃逸；/a/b 不误配 /a/bc）。
 *
 * 用 `relative` 判定而不是「base + 分隔符」前缀比较，一次解决三个坑：
 *   1. 盘根 base（`F:\` / `/`）：手工去尾分隔符会把 `F:\` 裁成 `F:`，而 `F:` 不含
 *      反斜杠 → 分隔符判成 `/` → 拼出 `F:/…` 与 `F:\…` 永不相等（白名单写盘根直接失效；
 *      README 与设置卡片推荐的正是 `D:\` 这种写法）。
 *   2. 大小写：Windows 路径不区分大小写，`c:\users\…` 与 `C:\Users\…` 必须算同一个位置
 *      （`path.win32.relative` 内部就做大小写归一）。
 *   3. 同名前缀：`/a/b` 与 `/a/bc` 靠 rel 是否以 `..` 开头来区分，不需要自己拼分隔符。
 */
export function isWithin(base, target) {
  if (typeof base !== 'string' || base === '' || typeof target !== 'string' || target === '') return false
  const rel = relative(resolve(base), resolve(target))
  if (rel === '') return true
  // rel 为 '..' 或以 '..' + 分隔符开头 = 在 base 之外；绝对路径 = 跨盘符（不同于 base）
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

/**
 * 解析到第一个真实存在的绝对路径；找不到返回 null。
 * 相对路径：先按指定会话 cwd，再遍历活会话 cwd，最后是持久化兜底基数。
 */
async function resolveFirst(p, cwd, sessions, extras, roots) {
  if (isAbsolute(p) || p.startsWith('~/')) {
    const abs = resolvePath(p, cwd)
    if (!isProbeable(abs, cwd, roots)) return null
    return existsSync(abs) ? abs : null
  }
  const tried = new Set()
  const attempt = (base) => {
    if (typeof base !== 'string' || base === '' || tried.has(base)) return null
    tried.add(base)
    const abs = resolve(base, p)
    if (!isWithin(base, abs)) return null
    return existsSync(abs) ? abs : null
  }
  const hit = attempt(cwd)
  if (hit !== null) return hit
  if (sessions !== undefined && typeof sessions.list === 'function') {
    for (const s of sessions.list()) {
      const hit2 = attempt(s && s.header && s.header.cwd)
      if (hit2 !== null) return hit2
    }
  }
  if (Array.isArray(extras)) {
    for (const base of extras) {
      const hit3 = attempt(base)
      if (hit3 !== null) return hit3
    }
  }
  return null
}

/**
 * 白名单根归一化：trim、`~/` 与 `~\` 展开、归一成绝对路径、大小写不敏感去重、滤空串。
 *
 * 归一化时**不能**手工砍尾部分隔符：`D:\` 砍成 `D:` 在 Windows 上是「D 盘当前目录」，
 * 不是盘根。盘根交给 resolve 保留，`D:\` 仍写出 `D:\`。
 */
export function normalizeRoots(list) {
  const out = []
  const seen = new Set()
  for (const item of list) {
    if (typeof item !== 'string') continue
    const r = item.trim()
    if (r === '') continue
    const expanded = r === '~'
      ? homedir()
      : (r.startsWith('~/') || r.startsWith('~\\') ? resolve(homedir(), r.slice(2)) : r)
    // 只写盘符（`D:`）时补成盘根，符合「白名单根」的本意
    const resolved = resolve(/^[a-zA-Z]:$/.test(expanded) ? expanded + sep : expanded)
    // 盘符统一大写：保证同一根不论大小写写法都落成同一个字符串（去重后才稳定）
    const root = process.platform === 'win32' ? resolved.charAt(0).toUpperCase() + resolved.slice(1) : resolved
    const key = normalizeKey(root)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}

/** 系统盘特征目录（根下存在即视为系统盘，拒绝白名单） */
const SYSTEM_MARKERS = process.platform === 'win32' ? ['Windows'] : ['System', 'etc']
const warnedRoots = new Set()

function isSystemRoot(root) {
  try {
    for (const marker of SYSTEM_MARKERS) {
      if (existsSync(join(root, marker))) {
        if (!warnedRoots.has(root)) {
          warnedRoots.add(root)
          console.warn('[dsh-GotoFile] 白名单根被拒绝（检测到系统盘特征 ' + marker + '）: ' + root)
        }
        return true
      }
    }
  } catch (error) {
    // 根不可探测等异常按"非系统盘"处理
  }
  return false
}

/**
 * 家目录里「默认不放行」的凭据 / 登录态目录（相对家目录的顶层名，大小写不敏感）。
 *
 * 家目录默认放行是为了让工作区在家目录下时不用配置就能双击；但这些目录里的文件
 * 一旦能被 `mode:"open"` 交给系统默认程序，等于把本机账号交出去：
 *   - AppData / Library：浏览器 Cookies、Local State（解出来就是登录态）
 *   - .ssh / .aws / .gnupg / .kube / .docker：长期凭据与私钥
 *   - .npmrc / .netrc / .git-credentials：明文 token
 * 命中这些目录**不是硬拒绝**：用户把它们写进白名单 = 显式授权，仍然放行（见 isProbeable）。
 */
const HOME_SENSITIVE = process.platform === 'win32'
  ? ['appdata', 'ntuser.dat', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.git-credentials', '.npmrc', '.netrc']
  : ['library', '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.config', '.git-credentials', '.npmrc', '.netrc']

/** abs 是否落在家的敏感子目录里（只看顶层名，避免把 `AppData` 之外的正常目录误伤） */
function isHomeSensitive(home, abs) {
  const rel = relative(resolve(home), resolve(abs))
  if (rel === '' || rel.startsWith('..')) return false
  const top = rel.split(sep)[0]
  const key = process.platform === 'win32' ? top.toLowerCase() : top
  return HOME_SENSITIVE.includes(key)
}

/**
 * 绝对路径是否可探测/可打开：本会话 cwd 内，或本机主目录内（敏感目录除外），
 * 或用户声明的白名单根内。
 * 白名单根额外两道闸：系统盘特征目录 → 拒绝；realpath 后逃出根（symlink）→ 拒绝。
 */
export function isProbeable(abs, cwd, roots) {
  if (typeof cwd === 'string' && cwd !== '' && isWithin(cwd, abs)) return true
  const home = homedir()
  if (home !== '' && home !== '/' && isWithin(home, abs)) {
    // 家目录默认放行；凭据类目录落到下面按显式白名单复核
    if (!isHomeSensitive(home, abs)) return true
  }
  if (!Array.isArray(roots)) return false
  for (const root of roots) {
    if (typeof root !== 'string' || root === '') continue
    if (!isWithin(root, abs)) continue
    if (isSystemRoot(root)) continue
    try {
      const base = realpathSync(root)
      if (isSystemRoot(base)) continue
      if (!isWithin(base, realpathSync(abs))) continue
    } catch (error) {
      continue
    }
    return true
  }
  return false
}

/** 本机地址形态（含 IPv6 回环）；捕获组 2 = 端口（可缺省） */
const LOCAL_HOST_PATTERN = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/i

/**
 * 本地 CSRF 防护：请求必须来自本机，且 Origin 的**端口**与本次请求的 Host 端口一致。
 *
 * 只判「是不是 localhost」是不够的：任何本地开发服务器（`localhost:5173` 之类）的页面
 * 都能朝 `127.0.0.1:<DSH 端口>` 发请求，而浏览器把这种请求的 Origin 写成它自己的源。
 * 因此这里要求端口相等——跨站页面永远拿不到本服务的端口，也就过不了这道闸。
 * 允许 `127.0.0.1` 与 `localhost` 互认（同机同端口的两种写法）。
 */
export function isSameOrigin(req) {
  const headers = (req && req.headers) || {}
  const origin = headers.origin
  const hostMatch = LOCAL_HOST_PATTERN.exec(String(headers.host || ''))
  if (hostMatch === null) {
    // 没有 Host：浏览器走 HTTP/1.1 强制带 Host，所以这种情况只会出现在非浏览器客户端
    // 或宿主转发丢了头。CSRF 不成立，退回「Origin 是不是本机形态」的宽松判定，
    // 免得因为一个缺失的头让整个功能 403。
    if (typeof origin !== 'string' || origin === '') return false
    try {
      const parsed = new URL(origin)
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && LOCAL_HOST_PATTERN.test(parsed.host)
    } catch (error) {
      return false
    }
  }
  // 无 Origin：同源 XHR / 非浏览器客户端（curl、宿主内部调用）——Host 已是本机即放行
  if (origin === undefined || origin === null || origin === '') return true
  let parsed
  try {
    parsed = new URL(String(origin))
  } catch (error) {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const originMatch = LOCAL_HOST_PATTERN.exec(parsed.host)
  if (originMatch === null) return false
  return (originMatch[2] || '') === (hostMatch[2] || '')
}

/**
 * 请求体必须是 JSON：只接受 `application/json`（含 `+json`）。
 *
 * 这不是洁癖——`text/plain` 的 body 在浏览器里属于「简单请求」，不触发 CORS 预检就能
 * 打到本机端口，而 readBody 只做 JSON.parse（不看 content-type）。限制类型后，跨站页面
 * 想发 JSON 就必须先过预检，本服务不响应预检 → 被浏览器挡下。
 */
export function isJsonRequest(req) {
  const raw = String((req && req.headers && req.headers['content-type']) || '').trim()
  return /^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(raw)
}

/**
 * 系统打开路径（execFile 直传参数，不经 shell）：
 *   reveal=false：macOS open / Windows explorer / Linux xdg-open（默认应用打开）
 *   reveal=true ：macOS open -R（Finder 定位选中）/ Windows explorer /select, / Linux xdg-open
 * 成功返回 true，失败返回 null。
 */
export function systemOpen(abs, isDir, reveal) {
  const platform = process.platform
  // explorer.exe 会把 D:/… 里的 / 当开关前缀，必须用原生反斜杠路径
  const native = platform === 'win32' ? abs.replace(/\//g, '\\') : abs
  const args = []
  if (platform === 'darwin') args.push(!reveal || isDir ? '' : '-R', native)
  else if (platform === 'win32') args.push(!reveal || isDir ? '' : '/select,', native)
  else args.push(native)
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open'
  const cleanArgs = args.filter((a) => a !== '')
  return new Promise((resolveOpen) => {
    execFile(command, cleanArgs, { timeout: 10000 }, (error) => {
      // explorer.exe 成功打开后常以退出码 1 返回（复用已有窗口），按启动成功处理
      const ok = error === null || error === undefined
        || (platform === 'win32' && typeof error.code === 'number')
      resolveOpen(ok ? true : null)
    })
  })
}

/** 收集请求体（JSON）。maxBytes 超出即中断并拒绝 */
function readBody(req, maxBytes) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let total = 0
    let aborted = false
    req.on('data', (chunk) => {
      total += chunk.length
      if (typeof maxBytes === 'number' && total > maxBytes) {
        aborted = true
        req.destroy()
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (aborted) return
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolveBody(text === '' ? {} : JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res, status, body) {
  // readBody 判定超限时会 req.destroy()，响应随之销毁；此时再 writeHead 会抛
  // ERR_STREAM_DESTROYED，把 catch 里的兜底写坏成未捕获异常
  if (res === undefined || res === null || res.destroyed === true || res.writableEnded === true) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}
