# 架构说明（dsh-GotoFile）

零依赖、无构建。两个源码文件：`lib/index.js`（宿主半）+ `lib/client.js`（浏览器半，
`window.__ModuleLoader__` bundle 格式）。测试在 `test/host.test.js`（`node --test`，裸克隆可直接跑：
宿主半对 `@deepseek-ai/schemastery` 的依赖是懒加载的，脱离 DSH 时退回恒等形态）。

## 目标

对话**结尾**以**文本**方式列出本轮产出 / 修改的文件（文件名 + 完整绝对路径 + 新/改标记），
**双击**某条路径即可在系统文件管理器（Windows 资源管理器 / macOS Finder / Linux 文件管理器）
中定位选中该文件。Linux 只能打开文件本身（`xdg-open` 无「选中」语义），见文末第 12 条。

## 数据流

```
 一轮对话
   │  工具调用（write / edit / str_replace_editor / ops_replace）
   ▼
┌────────────────────── 宿主半 lib/index.js ──────────────────────────┐
│ ctx.on('session/event')                                            │
│   tool/call   ──► pending.set(callId, {turn, items[]})              │
│                   write/edit 直接给路径；run_code（PTC）先解析脚本  │
│   tool/result ──► 成功才 recordPath()；isError / 无结果一律丢弃     │
│      ┌──────────────────────────────────────────────────────────┐   │
│      │ rec = { cwd, turns: Map<turn,file[]>, known: Set, pending}│   │
│      │ op：declaredNew 且 known 未收录 → 'new'，否则 'edit'      │   │
│      └──────────────────────────────────────────────────────────┘   │
│ 只登记顶层会话：origin==='subagent' 或 delegationDepth>0 直接跳过   │
│                                                                    │
│ 可选补漏：ctx.get('workspaceChanges').summary(sessionId, turn)     │
│   → 官方权威改动清单（含 git 快照），追加登记簿未覆盖的路径        │
│   服务缺失 / 无记录 → 静默降级为空数组，不影响主流程               │
│                                                                    │
│ POST /api/goto-file/check  {sessionId, turn} → {turn, files:[…]}    │
│ POST /api/goto-file/open   {sessionId, path, mode} → {ok, abs}      │
│ GET/POST /api/goto-file/config  {extraProbeRoots}                   │
│ 全部先过 isSameOrigin（本机 Origin/Host）防本地 CSRF              │
└────────────────────────────────────────────────────────────────────┘
   │  fetch（同源 /api/goto-file/*）
┌────────────────────── 浏览器半 lib/client.js ───────────────────────┐
│ ① 收集器 conversationEvents.register(kind:'mentionedPaths')         │
│    turn/start 建 context；assistant/message 抽取路径；              │
│    buildLocationData 把 state 发布到 turn.data（唯一发布通道）      │
│ ② turnTail slots.inject('conversation.chat.turnTail')               │
│    select：turn.data.mentionedPaths 为空 → 让位（返回 null），       │
│    有内容 → 组件向 /check 取**权威**清单（与正文提到什么无关），      │
│    每行渲染 `● 新/改 文件名 — 完整绝对路径` + 📂 按钮               │
│ ③ 双击：路径文本 onClick 里判 event.detail === 2 → /open reveal     │
│    正文双击委托（document dblclick）同样处理裸 <code> / 选中文本     │
│ ④ 设置卡片：settings.section + plugins.row.config +                 │
│    plugins.bundle.config 三处注册同一个外置盘白名单表单             │
└────────────────────────────────────────────────────────────────────┘
```

**为什么是文本而不是官方那张卡片**：官方 changed-files 卡片挂在同一槽位的先到先得链上，
且只在浏览器里渲染。本插件把同一份「本轮改动」数据渲染成纯文本行，便于整段复制、
离开 GUI 也能读，并且双击路径直接落到系统文件管理器。

## 关键决策与坑（源码级查证）

0. **PTC 模式把工具面收拢成单一 `run_code`，登记簿必须解析脚本**：DSH 的 `presentation: 'ptc'`
   （梁神模式）让模型只能调 `run_code`，写文件变成脚本里的 `tools.write({ file_path })` /
   `tools.edit({ file_path })`。实测一个 1478 次 tool/call 的会话里 **1478 次全是 run_code，write/edit 0 次**，
   按工具名认领的实现**一次都命不中**，报告永远是空的（表现为"插件装好了但什么都不显示"，无任何报错）。
   现在 `mutationsFromCode()` 按 `tools.*` 调用切窗口提取 `file_path` 字面量；变量路径与含 `${...}`
   的模板串跳过——宁可漏报，也不把猜出来的路径写进报告。回放该会话：120 次调用解析出 243 条路径，
   第 2 轮报告 10 条真实文件。
1. **登记时机用 `session/event`，不用 `tools/pre-execute`**：真实会话日志里
   `tool/call` 带 `{turn, step, callId, name, arguments}`（arguments 是 JSON 字符串），
   `tool/result` 带 `{turn, step, toolCallId, message:{isError}, sourceEventSeqs}`。
   配对才能区分成功与失败；`tools/pre-execute` 只有调用前信息，会给失败/只读调用记账。
2. **官方 `workspaceChanges.summary` 的第二参数是「宣告事件的 seq」，不是轮次号。**
   本插件不做硬假设：传轮次号，命中就补漏，未命中返回空数组（登记簿仍是主来源）。
3. **`chatFileMentions` 单例被官方 deliverables 占用**（`ctx.provide` 重复注册直接抛错），
   所以正文里的路径只能靠 **DOM 双击委托** 变可点，不能扩展官方渲染层。
4. **官方 `openFile` 不是系统打开**（= `workspaces.openPath`，DSH 内部预览）；
   系统打开必须自己写宿主路由 + `execFile` 直传参数（不经 shell）。
5. **Windows 上 `explorer.exe` 会把 `D:/x` 里的 `/` 当开关前缀**：发送前必须把路径
   统一转成原生反斜杠；`explorer` 成功打开后也常以退出码 1 返回，按「已启动」处理。
6. **`turnTail` 槽双模**：DSH ≥ 0.1.7 是 list 槽（缺 `options.id` 抛
   `list slot "…turnTail" requires options.id`），< 0.1.7 是 chain 槽（缺 `options.select` 抛
   `chain slot "…turnTail" requires options.select`）。同时声明 `id` 与 `select` 即可自适应。
7. **`webServer` 必须动态注入**（`ctx.inject(['webServer'], …)`）：它是 Web/桌面宿主专有服务，
   静态写进 `inject` 会让插件在 headless 宿主里永远 pending。
8. **路径安全口径**：相对路径按会话 cwd 解析；绝对路径 / `~/` / `~\` 必须落在会话 cwd
   或本机主目录内（家目录里的凭据类目录除外：`AppData`、`Library`、`.ssh`、`.aws`、`.gnupg`、
   `.kube`、`.docker`、`.npmrc`、`.netrc`、`.git-credentials`），或落在用户显式声明的白名单根内
   （写进白名单 = 显式授权，敏感目录也会放行）；白名单根额外两道闸——根下存在系统盘特征目录
   （win32 `Windows`，类 Unix `System` / `etc`）→ 拒绝，`realpathSync` 后逃出根（symlink）→ 拒绝。
9. **`isWithin` 不能靠拼前缀**：这个函数踩过两次坑。先是没去尾部分隔符，白名单写 `F:\` 时拼出
   `F:\\` 漏配自己的子路径；改成「手工去尾」后又把盘根裁成了 `F:`（Windows 上 `F:` 是「F 盘当前
   目录」，不是盘根），分隔符随之判成 `/`，于是 `F:\…` 永远匹配不上——正好是 README 和设置卡片
   推荐的写法。现在改用 `relative()` 判定：盘根、大小写（`path.win32` 内部归一）、`/a/b` 与
   `/a/bc` 的同名前缀三个问题一次解决，单测固化盘根与大小写两条回归。
10. **同源校验必须绑端口**：只判「Origin 是不是 localhost」等于放行任何本地开发服务器
   （`localhost:5173` 的页面也能打 `127.0.0.1:<DSH 端口>`）。现在要求 Origin 的端口与本次请求
   Host 的端口完全一致（`127.0.0.1` 与 `localhost` 互认）；Host 缺失时退回「Origin 是否本机形态」，
   免得宿主转发丢头导致功能整体 403。
11. **请求体只收 `application/json`**：`text/plain` 的 body 在浏览器里是「简单请求」，不触发 CORS
   预检就能打到本机端口，而 `readBody` 只做 `JSON.parse`（不看 content-type）。限制类型后，跨站页面
   想发 JSON 就必须先过预检，本服务不响应预检 → 请求被浏览器挡下。
12. **Linux 的 reveal 只能是 open**：`explorer /select,` 与 `open -R` 都有明确的「选中」参数，
   `xdg-open` 没有——它只按 MIME 类型用默认程序打开文件。所以 Linux 上双击 = 打开文件本身
   （目录则打开目录），不是「定位并选中」。要真选中得按文件管理器分别走 D-Bus
   （Nautilus `org.freedesktop.FileManager1.ShowItems`、Dolphin `--select` 等），本插件不做。

## 配置（外置盘白名单）

默认空 = 只放行家目录与会话工作目录内的路径。外置盘 / 网络盘目录里的文件要在报告里
可双击，就到 `设置 → GotoFile` 把根目录逐行填进去，**保存即生效**（每次请求现读
`extraProbeRoots` 的 volatile 引用，不重启、不改 patch.yml）。

## 已知边界

- 通过 `ops_bash` 等外部命令产生的文件（例如 `> out.txt`、`git checkout`）不在登记簿里，
  只能靠官方 `workspaceChanges` 的 git 快照补漏；非 git 目录下这类改动不会出现。
- 被其他进程改名的文件会显示为「已不存在」并置灰，双击无效。
- 单轮文件数上限 `maxFilesPerTurn`（默认 200）之外的条目被忽略，防止病态轮次撑爆登记簿。
