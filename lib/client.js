// dsh-GotoFile — Client 半（window.__ModuleLoader__ bundle，零构建）
//
// 1. turnTail 文本块：本轮产出 / 修改的文件（宿主 /api/goto-file/check 给权威清单），
//    每行 = 状态标记 + 文件名 + 完整路径；双击路径文本 → 文件管理器中定位选中。
// 2. 正文双击委托：正文里的裸路径（<code> 或裸文本）双击同样调 /api/goto-file/open。
// 3. 设置卡片：外置盘白名单（extraProbeRoots），保存即生效。
// dsh 0.2.1-rc 起，客户端模块的注册 id 必须是**包名**（dsh-gotofile）：
// 加载器按包名核对"这个文件执行后有没有注册对应模块"，写 dsh-GotoFile 会被判
// "loaded without registering"，整个 web boot 直接失败（"无法使用"）。
window.__ModuleLoader__.load({
  id: "dsh-gotofile",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    // 模块级：最近渲染的会话 id（正文双击委托用，组件渲染时更新）
    let currentSessionId = null;

    const inject = ["slots"];

    const FOLDER_SVG = "<svg width='12' height='12' viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M2 5.5V4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-6z'/></svg>";

    // ── 官方设置卡片壳（视觉对齐 dsh PluginCard）──
    const CARD_CSS = ".dsh-settings-card{list-style:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;transition:border-color .16s,background .16s}.dsh-settings-card:hover{border-color:var(--dsw-alias-label-dimmed)}.dsh-settings-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}.dsh-settings-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:none;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px}.dsh-settings-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.dsh-settings-headtext{display:flex;flex-direction:column;flex:1;min-width:0;gap:4px}.dsh-settings-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.dsh-settings-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.dsh-settings-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.dsh-settings-open .dsh-settings-chevron{transform:rotate(180deg)}.dsh-settings-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:10px 0 8px}.dsh-settings-body input,.dsh-settings-body textarea,.dsh-settings-body select{box-sizing:border-box;max-width:100%;min-width:0}";
    let cardCssInjected = false;
    function injectCardCss() {
      if (typeof document === "undefined" || cardCssInjected) return;
      cardCssInjected = true;
      if (document.getElementById("dsh-gf-settings-card-style") !== null) return;
      const tag = document.createElement("style");
      tag.id = "dsh-gf-settings-card-style";
      tag.textContent = CARD_CSS;
      document.head.appendChild(tag);
    }

    // ── 设置卡片：外置盘白名单 ──
    function SettingsCard(props) {
      const [text, setText] = react.useState("");
      const [saving, setSaving] = react.useState(false);
      const [msg, setMsg] = react.useState(null);
      const [saved, setSaved] = react.useState(false);
      const savedTimer = react.useRef(null);
      react.useEffect(() => {
        let alive = true;
        fetch("/api/goto-file/config", { method: "GET", cache: "no-store" })
          .then((r) => r.json())
          .then((d) => {
            if (alive && d && Array.isArray(d.extraProbeRoots)) setText(d.extraProbeRoots.join("\n"));
          })
          .catch(() => {});
        return () => { alive = false; };
      }, []);
      react.useEffect(() => () => {
        if (savedTimer.current !== null) clearTimeout(savedTimer.current);
      }, []);
      function save() {
        const list = text.split("\n").map((s) => s.trim()).filter((s) => s !== "");
        setSaving(true);
        setMsg(null);
        fetch("/api/goto-file/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ extraProbeRoots: list }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (d && d.ok) {
              setText(list.join("\n"));
              setMsg({ kind: "ok", text: "已保存，立即生效" });
              setSaved(true);
              if (savedTimer.current !== null) clearTimeout(savedTimer.current);
              savedTimer.current = setTimeout(() => { setSaved(false); savedTimer.current = null; }, 2000);
            } else {
              setMsg({ kind: "err", text: "保存失败：" + ((d && d.error) || "未知错误") });
            }
          })
          .catch(() => setMsg({ kind: "err", text: "保存失败：网络错误" }))
          .finally(() => setSaving(false));
      }
      return react.createElement("div", { style: { padding: "8px 0", fontSize: 13 } },
        props && props.inCard ? null : react.createElement("h3", { style: { margin: "0 0 8px", fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, "GotoFile"),
        react.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, marginBottom: 8, lineHeight: "18px" } },
          "外置盘白名单：本机目录（家目录内与会话工作目录）默认可显示、可双击定位，无需配置；此处只登记外置盘/网络盘根目录（如 D:\\\\、E:\\\\某目录），每行一个。系统盘特征目录会被自动拒绝。"),
        react.createElement("textarea", {
          value: text,
          onChange: (e) => setText(e.target.value),
          rows: 4,
          spellCheck: false,
          placeholder: "D:\\\n~/Desktop",
          style: {
            width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: 12,
            fontFamily: "monospace", color: "var(--dsw-alias-label-secondary, #666)",
            background: "transparent",
            border: "1px solid var(--dsw-alias-border-l1, #e5e5e5)",
            borderRadius: 6, resize: "vertical",
          },
        }),
        react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 8 } },
          react.createElement("button", {
            type: "button",
            onClick: save,
            disabled: saving,
            className: "dsh-gf-save" + (saved ? " is-saved" : ""),
          }, saving ? "保存中…" : (saved ? "✓ 已保存" : "保存")),
          msg !== null && react.createElement("span", {
            style: { fontSize: 12, color: msg.kind === "ok" ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)" },
          }, msg.text)),
      );
    }

    let clientCtx = null;
    function liveSessions() {
      try {
        return clientCtx !== null ? clientCtx.get("sessions") : undefined;
      } catch (error) {
        return undefined;
      }
    }

    // TDZ 修复：声明提前到 apply 之前
    let convRegistry = null;

    function apply(ctx) {
      const slots = ctx.get("slots");
      clientCtx = ctx;
      if (slots === undefined) return;
      ensureConvEvents();
      injectCardCss();

      if (typeof document !== "undefined" && !document.getElementById("dsh-gf-style")) {
        const tag = document.createElement("style");
        tag.id = "dsh-gf-style";
        tag.textContent = [
          ".dsh-gf-path{cursor:pointer;user-select:text;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px;}",
          ".dsh-gf-path:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.06));border-radius:3px;}",
          ".dsh-gf-path:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-radius:3px;}",
          ".dsh-gf-copy{font:inherit;font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,0.12));background:transparent;color:var(--dsw-alias-label-tertiary,#999);cursor:pointer;}",
          ".dsh-gf-copy:hover{color:var(--dsw-alias-label-primary);}",
        ].join("");
        document.head.appendChild(tag);
      }

      // ── 本轮路径收集器（正文里提到过哪些路径，供正文双击与兜底显示）──
      // 契约：0.1.1- 为 conversationEvents 服务；0.1.2 起改为 uiConversation.events，
      // 且两者都可能晚于插件 apply（模块化时序）——惰性注册、双源、幂等。
      function ensureConvEvents() {
        if (convRegistry !== null) return true;
        try {
          const legacy = clientCtx !== null ? clientCtx.get("conversationEvents") : undefined;
          const uiConv = clientCtx !== null ? clientCtx.get("uiConversation") : undefined;
          const target = legacy !== undefined
            ? legacy
            : uiConv !== undefined && uiConv.events !== undefined
              ? uiConv.events
              : undefined;
          if (target === undefined || typeof target.register !== "function") return false;
          target.register(mentionedPathsDefinition);
          convRegistry = target;
          return true;
        } catch (error) {
          return false;
        }
      }
      const mentionedPathsDefinition = {
        kind: "mentionedPaths",
        match: (event) => {
          if (event.type === "turn/start") return { id: String(event.data.turn), role: "start" };
          if (event.type === "assistant/message") return { id: String(event.data.turn), role: "update" };
          return null;
        },
        start: (context, match) => ({ turn: match.event.data.turn, paths: [] }),
        update: (context, match) => {
          if (match.event.type !== "assistant/message") return context.state;
          // 内容在 message.content（协议块数组），不是 data.content
          const found = extractPaths(match.event.data.message && match.event.data.message.content);
          if (found.length === 0) return context.state;
          const merged = [...context.state.paths];
          for (const p of found) if (!merged.includes(p)) merged.push(p);
          return { ...context.state, paths: merged };
        },
        // state → turn.data 的唯一发布通道（同官方 deliverables 模式）
        buildLocationData: (context, scope) => scope !== "turn" || context.state === void 0 ? null : {
          kind: "turn",
          turn: context.state.turn,
          key: "mentionedPaths",
          value: { paths: context.state.paths },
        },
      };

      // ── 系统打开（多会话 × 多路径组合兜底）──
      function allSessionIds() {
        try {
          const svc = liveSessions();
          const snap = svc && svc.list && typeof svc.list.getSnapshot === "function" ? svc.list.getSnapshot() : null;
          return snap && snap.byId ? Object.keys(snap.byId) : [];
        } catch (error) {
          return [];
        }
      }
      const preferredSession = new Map(); // path -> sessionId
      async function robustOpen(path, mode) {
        const ids = [];
        const pref = preferredSession.get(path);
        if (pref !== undefined) ids.push(pref);
        if (currentSessionId !== null) ids.push(currentSessionId);
        for (const id of allSessionIds()) if (!ids.includes(id)) ids.push(id);
        // Windows: explorer.exe 会把 D:/… 中的 / 当开关前缀，发送前统一转原生反斜杠
        let target = path;
        if (/^[A-Za-z]:\//.test(path)) target = path.replace(/\//g, "\\");
        const bare = !target.includes("/") && !target.includes("\\");
        const isAbs = target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith("\\\\") || target.startsWith("~/") || target.startsWith("~\\");
        const cwdSet = new Set();
        try {
          const svc = liveSessions();
          const snap = svc && svc.list && typeof svc.list.getSnapshot === "function" ? svc.list.getSnapshot() : null;
          if (snap && snap.byId) {
            for (const id of ids) {
              const cwd = snap.byId[id] && snap.byId[id].cwd;
              if (typeof cwd === "string" && cwd !== "") cwdSet.add(cwd);
            }
          }
        } catch (error) {
          // 无会话快照时只发原始路径
        }
        const separator = (typeof navigator !== "undefined" && /win/i.test(navigator.platform || "")) ? "\\" : "/";
        const joinPath = (base, rel) => base.replace(/[\\/]+$/, "") + separator + rel.replace(/^[\\/]+/, "");
        for (const id of ids) {
          const tries = [];
          if (!isAbs) {
            for (const cwd of cwdSet) {
              tries.push(joinPath(cwd, target));
              if (bare) tries.push(joinPath(cwd, "docs" + separator + target));
            }
          }
          tries.push(target);
          if (bare) tries.push("docs/" + target);
          for (const candidate of tries) {
            try {
              const res = await fetch("/api/goto-file/open", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sessionId: id, path: candidate, mode: mode || "reveal" }),
                cache: "no-store",
              });
              if (res.ok) {
                preferredSession.set(path, id);
                return true;
              }
            } catch (error) {
              // 继续试下一个组合
            }
          }
        }
        return false;
      }

      // ── 路径提取：从 assistant 文本块里找出像路径的 token ──
      const EXT = "(md|markdown|txt|text|json|js|jsx|ts|tsx|py|yaml|yml|toml|css|html|svg|png|jpg|jpeg|gif|webp|pdf|docx|xlsx|csv|log|sh|bash|env|lock|mod|sum|gradle|xml|ini|conf|cfg|sql|db|wasm|c|cpp|h|hpp|java|go|rs|rb|php|vue|svelte|astro|scss|less)";
      const ABS = new RegExp("(?:[A-Za-z]:[\\\\/][^\\s`\"'，。；、()（）]+|/[a-zA-Z][a-zA-Z0-9_-]*/[^\\s`\"'，。；、()（）]+|~/[^\\s`\"'，。；、()（）]+)", "g");
      const REL = new RegExp("(?:^|[\\s(（`])([^\\s`\"'，。；、()（）\\[\\]]+\\." + EXT + ")(?=[\\s)）\\]`，。；、:.])", "g");

      function extractPaths(content) {
        const out = [];
        const push = (p) => {
          const t = p.replace(/[，。；、)）]$/, "").trim();
          if (t === "" || /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.length > 300) return;
          if (!out.includes(t)) out.push(t);
        };
        if (!Array.isArray(content)) return out;
        for (const block of content) {
          if (!block || block.type !== "text" || typeof block.text !== "string") continue;
          const segments = block.text.split(/```[^\n]*\n[\s\S]*?```/g);
          for (const seg of segments) {
            for (const m of seg.matchAll(ABS)) push(m[0]);
            for (const m of seg.matchAll(/`([^`]+)`/g)) push(m[1]);
            for (const m of seg.matchAll(REL)) push(m[1]);
          }
        }
        return out;
      }

      /** 文本是否像路径（正文双击的入口条件） */
      function pathish(text) {
        if (text === "" || text.length > 300) return false;
        if (/:\/\//i.test(text)) return false;
        if (/^\/\//.test(text)) return false;
        if (/^(?:www\.|[a-z0-9-]+(?:\.[a-z0-9-]+)+\/)/i.test(text)) return false;
        if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\") || text.startsWith("~/") || text.startsWith("~\\") || text.startsWith("/")) return true;
        return new RegExp("\\." + EXT + "\\b", "i").test(text);
      }

      // ── 正文双击委托：双击正文里的路径 → 文件管理器定位 ──
      // 跳过官方 UI 元素（<button>/<a>/<pre>），只处理裸 <code> 与裸路径文本。
      function onDocumentDblClick(event) {
        const target = event.target;
        if (target === null || target.nodeType !== 1) return;
        if (target.closest("button") !== null || target.closest("a") !== null || target.closest("pre") !== null) return;
        const code = target.closest("code");
        if (code !== null) {
          const text = (code.textContent || "").trim();
          if (!pathish(text)) return;
          event.preventDefault();
          void robustOpen(text, "reveal");
          return;
        }
        const selection = typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
        const selected = selection === null ? "" : String(selection.toString() || "").trim();
        if (pathish(selected)) {
          event.preventDefault();
          void robustOpen(selected, "reveal");
        }
      }
      ctx.effect(() => {
        document.addEventListener("dblclick", onDocumentDblClick);
        return () => document.removeEventListener("dblclick", onDocumentDblClick);
      }, "goto-file: body double-click delegation");

      // ── turnTail：本轮产出 / 修改的文件文本报告 ──
      // 双模兼容：DSH >= 0.1.7 是 list 槽（必须给 options.id）；< 0.1.7 是 chain 槽
      // （必须给 options.select）。两者同时声明即可无报错自适应。
      slots.inject("conversation.chat.turnTail", () => {
        ensureConvEvents();
        return slots.register(
          {
            name: "conversation.chat.turnTail",
            id: "dsh-GotoFile-turn-tail",
            select: (owner) => {
              const data = owner.turn && owner.turn.data ? owner.turn.data.get("mentionedPaths") : undefined;
              const paths = data && Array.isArray(data.paths) ? data.paths : [];
              return paths.length === 0 ? null : paths;
            },
          },
          (props) => {
            const sessionId = props.sessionId || (props.turn && props.turn.sessionId) || "";
            if (sessionId !== "") currentSessionId = sessionId;
            const turn = props.turn && typeof props.turn.turn === "number" ? props.turn.turn : undefined;
            const [files, setFiles] = react.useState(null);
            const [copied, setCopied] = react.useState(false);
            const [error, setError] = react.useState(null);

            react.useEffect(() => {
              let alive = true;
              if (sessionId === "" || turn === undefined) {
                setFiles([]);
                return;
              }
              fetch("/api/goto-file/check", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sessionId: sessionId, turn: turn }),
                cache: "no-store",
              })
                .then((res) => res.json())
                .then((data) => {
                  if (!alive) return;
                  setFiles(data && Array.isArray(data.files) ? data.files : []);
                })
                .catch(() => {
                  if (alive) setFiles([]);
                });
              return () => { alive = false; };
            }, [sessionId, turn]);

            const list = files === null ? [] : files;
            const pathsKey = list.map((f) => f.abs).join("\u0000");
            const stable = react.useMemo(() => list, [pathsKey]);

            function reveal(abs) {
              setError(null);
              fetch("/api/goto-file/open", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sessionId: sessionId, path: abs, mode: "reveal" }),
                cache: "no-store",
              })
                .then((res) => res.json())
                .then((data) => {
                  if (!data || data.ok !== true) setError((data && data.error) || "打开失败");
                })
                .catch(() => setError("打开失败：网络错误"));
            }

            function copyAll() {
              const text = stable.map((f) => f.abs).join("\n");
              const done = () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              };
              try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  navigator.clipboard.writeText(text).then(done).catch(() => setError("复制失败"));
                  return;
                }
              } catch (error) {
                // 回落下面的兜底
              }
              try {
                const area = document.createElement("textarea");
                area.value = text;
                document.body.appendChild(area);
                area.select();
                document.execCommand("copy");
                document.body.removeChild(area);
                done();
              } catch (error) {
                setError("复制失败");
              }
            }

            if (stable.length === 0) return null;

            const rows = stable.map((file, index) => {
              const missing = file.exists === false;
              const dotColor = missing
                ? "var(--dsw-alias-label-tertiary, #999)"
                : file.op === "new"
                  ? "var(--dsw-alias-state-success-primary, #2ecc71)"
                  : "var(--dsw-alias-state-warning-primary, #e0a020)";
              const label = file.op === "new" ? "新" : "改";
              return react.createElement("div", {
                key: file.abs + "#" + index,
                style: { display: "flex", alignItems: "baseline", gap: "6px", lineHeight: "20px" },
              },
                react.createElement("span", { style: { color: dotColor, fontSize: "10px", width: "10px", flex: "none" } }, "●"),
                react.createElement("span", {
                  style: { color: missing ? "var(--dsw-alias-label-tertiary, #999)" : "var(--dsw-alias-label-secondary, #666)", fontSize: "11px", flex: "none" },
                }, label),
                react.createElement("span", {
                  className: "dsh-gf-path",
                  role: "button",
                  tabIndex: 0,
                  title: missing ? "文件不存在" : file.abs + "\n双击在文件管理器中定位",
                  onClick: (event) => { if (event.detail === 2 && !missing) reveal(file.abs); },
                  onKeyDown: (event) => { if (event.key === "Enter" && !missing) reveal(file.abs); },
                  style: {
                    fontFamily: "monospace",
                    fontSize: "12px",
                    color: missing
                      ? "var(--dsw-alias-label-tertiary, #999)"
                      : "var(--dsw-alias-label-primary, #222)",
                    wordBreak: "break-all",
                  },
                }, file.name),
                react.createElement("span", {
                  className: "dsh-gf-path",
                  title: missing ? "文件不存在" : file.abs + "\n双击在文件管理器中定位",
                  onClick: (event) => { if (event.detail === 2 && !missing) reveal(file.abs); },
                  style: {
                    fontFamily: "monospace",
                    fontSize: "11px",
                    color: missing
                      ? "var(--dsw-alias-label-tertiary, #999)"
                      : "var(--dsw-alias-label-tertiary, #777)",
                    wordBreak: "break-all",
                  },
                }, "— " + file.abs),
                missing ? react.createElement("span", {
                  style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)", flex: "none" },
                }, "（已不存在）") : null,
                missing ? null : react.createElement("button", {
                  type: "button",
                  className: "dsh-gf-copy",
                  title: "在文件管理器中定位",
                  onClick: () => reveal(file.abs),
                  dangerouslySetInnerHTML: { __html: FOLDER_SVG },
                }),
              );
            });

            return react.createElement("div", {
              style: {
                marginTop: "6px",
                paddingTop: "6px",
                borderTop: "1px dashed var(--dsw-alias-border-l1, rgba(0,0,0,0.12))",
                display: "flex",
                flexDirection: "column",
                gap: "2px",
              },
            },
              react.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
                react.createElement("span", {
                  style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #999)" },
                }, "本轮产出 / 修改 " + stable.length + " 个文件（双击路径在文件管理器中定位）"),
                react.createElement("button", {
                  type: "button",
                  className: "dsh-gf-copy",
                  onClick: copyAll,
                  title: "复制全部路径",
                }, copied ? "✓ 已复制" : "复制全部"),
                error !== null ? react.createElement("span", {
                  style: { fontSize: "11px", color: "var(--dsw-alias-state-error-primary, #d33)" },
                }, error) : null,
              ),
              ...rows,
            );
          },
        );
      });

      // ── 设置卡片：外置盘白名单（侧边栏页 + 插件卡片，内容一致）──
      slots.inject("settings.section", () => slots.register(
        { name: "settings.section", id: "dsh-GotoFile-settings", order: 41, label: "GotoFile" },
        () => react.createElement(SettingsCard),
      ));

      const ROW_CONFIG_KEY = "dsh-gotofile#goto-file";
      slots.inject("plugins.row.config", () => slots.register(
        { name: "plugins.row.config", key: ROW_CONFIG_KEY, order: 31, label: "GotoFile" },
        () => react.createElement(SettingsCard, { inCard: true }),
      ));

      slots.inject("plugins.bundle.config", () => slots.register(
        { name: "plugins.bundle.config", key: "dsh-gotofile", order: 31, label: "GotoFile" },
        () => react.createElement(SettingsCard, { inCard: true }),
      ));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
