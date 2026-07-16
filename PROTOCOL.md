# 取景框 · 接入协议

本 repo 只包含桌面 App。它对外就是一个 WebSocket 客户端——**任何实现了本文档消息的服务端都能驱动它**，后面挂 Anthropic API、Claude Code、Codex 还是别的，都是你服务端内部的事。

三个角色：

```
┌──────────────┐  WebSocket   ┌──────────────┐  你自己决定   ┌──────────────┐
│  桌面 App     │ ◄──────────► │  你的服务端   │ ◄──────────► │  AI 后端      │
│  (本 repo)   │              │  (自建,~200行)│              │ API/CC/Codex │
└──────────────┘              └──────┬───────┘              └──────┬───────┘
                                     │  localhost HTTP             │ stdio
                                     └───────────► MCP server ◄────┘ (mcp/ 目录)
```

## 1. 连接与鉴权

- App 连 `wss://你的域名/?token=<口令>`（App 设置页里填）。
- 口令错误：服务端 `ws.close(4001)`，App 会显示"口令不对"并弹设置页。
- 连上后 App 发 `{"type":"vf_hello"}` 自报身份；服务端应把这条连接标记为"当前取景框"，并回 `{"type":"vf_ready"}`。
- **单取景框策略**：新的 `vf_hello` 到来时把旧连接的标记摘掉，防止调试残留的旧连接抢答。

## 2. App → 服务端

| 消息 | 含义 |
|---|---|
| `{type:"vf_hello"}` | 连接后自报身份 |
| `{type:"chat", content:string}` | 用户发的文字 |
| `{type:"file", name, mime:"image/jpeg", data:<base64>, text?}` | 用户主动截图（可附带一句文字） |
| `{type:"vf_shot", requestId, data?:<base64 jpeg>, error?:string, desc?:string}` | 对 `vf_capture`/`vf_action` 的应答；`desc` 是托管动作的描述（如"单击 (420,310)"） |

## 3. 服务端 → App

| 消息 | 含义 |
|---|---|
| `{type:"history", items:[{who:"me"\|"ai", text?, ...}]}` | 连接时回放历史（App 只取尾部渲染） |
| `{type:"delta"}` | AI 正在输出（App 显示"输入中"，不需要带增量文本） |
| `{type:"done", text}` | AI 的完整回复。文本里的分隔符（默认 `\|\|\|`，App 可配）会被切成多个气泡 |
| `{type:"status", state:"starting"\|"ready"\|"restarting"\|"ended"}` | 连接状态文案 |
| `{type:"resend", text}` | 服务端替用户补发了一条消息（App 渲染成"我"的气泡） |
| `{type:"vf_capture", requestId, mode:"temp"\|"keep"}` | 请求 App 截一张框内画面 |
| `{type:"vf_action", requestId, action}` | 请求 App 注入一步/一串鼠标键盘操作 |
| `{type:"error", message}` | 显示为系统气泡 |

## 4. 截图环（AI 看屏幕）

```
AI 的 MCP 工具 → POST localhost/内部端点 → 服务端推 vf_capture → App 截图
→ App 回 vf_shot(requestId, data) → 服务端配对 requestId → HTTP 响应返回 MCP
```

- 服务端用 `requestId`（随机 UUID）配对请求与应答，**建议 20s 超时**（App 掉线/卡住时别让 AI 干等）。
- `mode:"temp"`：看完即焚的临时图。参考实现：落盘用 `vftemp-` 前缀，定时器 10 分钟后自毁，AI 读过后再从对话上下文里剥离。
- `mode:"keep"`：正式留档。
- App 侧行为：截图瞬间取景框边缘闪光（用户在场就知道 AI 看了），并在对话卡里贴出 AI 看到的画面，用户随时可核对。

## 5. 托管环（AI 操作鼠标键盘）

```
MCP → 内部端点 → vf_action{requestId, action} → App 注入(仅 Windows)
→ 等界面反应(wait_ms) → 自动补一张截图 → vf_shot{requestId, data, desc}
```

- **建议 60s 超时**（批量最慢：12 步 + 步间停顿 + 末尾最多等 10s）。
- 回图建议直接 base64 内联进 MCP 工具结果（AI 当场看到操作后果，形成"看-动-看"循环），不落盘。
- App 侧安全闸：托管开关只能由用户在全屏模式下手动打开；Esc 随时退出。

### action 对象

单步：

```json
{ "type": "click", "x": 420, "y": 310, "wait_ms": 1500 }
```

| type | 参数 |
|---|---|
| `move` / `click` / `double_click` / `right_click` | `x`,`y`（App 发来那张截图上的像素，左上角 0,0） |
| `drag` | `x`,`y` 起点 → `x2`,`y2` 终点 |
| `scroll` | `x`,`y` + `amount`（正上负下，默认 -3） |
| `type_text` | `text`（逐字注入，绕过输入法；无需坐标） |
| `press_key` | `key`（enter/tab/esc/方向键/f1…f12/单个字母数字）+ `mods`（如 `["ctrl","shift"]`；无需坐标） |

公共参数 `wait_ms`：操作后等界面反应多久再截图（毫秒，默认 600，上限 10000）。

批量（一串坐标可预测的连招，一次做完只回最后一张图）：

```json
{ "type": "batch", "wait_ms": 2000,
  "steps": [
    { "type": "click", "x": 420, "y": 310 },
    { "type": "type_text", "text": "hello" },
    { "type": "press_key", "key": "enter" }
  ] }
```

- `steps` 上限 12 步；步内 `wait_ms` 是"这步做完到下一步"的间隔（默认 150ms）；顶层 `wait_ms` 管最后截图前的等待。

## 6. 内部 HTTP 端点（服务端为 MCP 提供）

MCP server（`mcp/index.js`）通过两个 localhost 端点驱动上面两个环：

- `POST /api/internal/vf-capture` `{mode:"temp"|"keep"}`
  → `{ok:true, path:"<落盘路径>"}` 或 `{ok:false, error:"offline"|...}`
- `POST /api/internal/vf-action` `{action:{...}}`
  → `{ok:true, data:"<base64 jpeg>", desc:"单击 (420,310)"}` 或 `{ok:false, error}`

**必须只允许 loopback 直连**：校验 `remoteAddress` 是 `127.0.0.1/::1`，且带 `x-forwarded-for` 头的一律拒绝（防经反代绕进来）。这两个端点不带 token，安全边界就是"只有本机进程能调"。

## 7. AI 后端桥（chat → AI → done）

这一段完全自由，只要满足：收到 `chat`/`file` 后把内容交给你的 AI，开始生成时广播 `delta`，生成完广播 `done`。三条参考路线：

- **Anthropic API 直连**：服务端自己维护 messages 数组，`file` 的截图作 image content block；把两个内部端点包装成 tool 定义放进工具循环，就不需要 MCP。
- **Claude Code（headless / Agent SDK）**：把 `mcp/index.js` 注册进 MCP 配置，`chat` 文本喂给会话，截图走文件路径让它 Read。工具用法说明用 skill 承载（见 `mcp/SKILL.md`），工具描述保持极简。
- **Codex CLI**：同样挂 `mcp/index.js`（codex 支持 stdio MCP），其余同上。

## 8. 安全须知

- **托管 = 把鼠标键盘交给远端 AI**。务必：wss（TLS）+ 强口令；托管开关保持"用户手动打开、Esc 可退"的设计；AI 侧提示词里写明"花钱/删除/发送类操作先问人"。
- 内部端点只听 localhost（见第 6 节）。
- 截图里可能有敏感内容，`temp` 模式的自毁管线值得认真实现。
