# 取景框

> 当前是 `codex/game` 游戏分支；除 `main` 的全部功能外，还包含本地星露谷/NagiBridge 游戏网关。接入方式与安全边界见 [GAME_MCP.md](GAME_MCP.md)。

给 AI 伴侣/助手一双"看得见你屏幕"的眼睛——但只看你允许的那一块。

桌面上放一个**置顶取景框**（可拖动、可缩放），旁边贴一张小小的**对话卡**。框在哪、框多大，都是你定的：

- 你可以随手截一张框内画面发给 AI；
- AI 也可以主动"看一眼"框内画面（截图瞬间框边闪光，你在场就知道）；
- 你在全屏模式亲手打开**托管**开关后，AI 还能替你操作鼠标键盘（每步操作自动回一张新画面，Esc 随时收回）。
- 可以把框内画面录成 WebM 视频；录制内容只写入本机「视频/取景框」目录，不经过服务器，录制期间会自动锁定取景框；
- 对话卡上沿有一只会根据聊天、输入、托管和连接状态切换表情的小螃蟹桌宠，主题里可换色或关闭；
- 消息里的 `*文字*` 会按 CommonMark 的内侧非空格规则显示为斜体。

Windows Electron 应用。外观全面可主题化（见 [THEME.md](THEME.md)），昼夜自动切换。

## 这个 repo 包含什么

| 部分 | 状态 |
|---|---|
| 桌面 App（取景框 + 对话卡 + 截图 + 本地录屏 + 托管注入 + 桌宠 + 主题） | ✅ 完整，本 repo 主体 |
| WS 通信协议 | ✅ 文档化，见 [PROTOCOL.md](PROTOCOL.md) |
| AI 侧 MCP server + 使用说明 skill | ✅ [`mcp/`](mcp/) 目录 |
| 服务端 | ❌ 需自建（约 200 行，协议文档里有全部细节） |

App 对外只是一个 WebSocket 客户端。**实现 PROTOCOL.md 里那十来条 JSON 消息的服务端就能驱动它**——后面接 Anthropic API、Claude Code、Codex 还是别的模型，都是你服务端内部的事，App 一行不用改。

## 快速开始

```bash
npm install
npx electron-builder --win   # 产物在 dist/，portable 单 exe
```

（在 Linux 上交叉打 Windows 包已配好 `signAndEditExecutable: false`，直接跑就行。）

首次启动会弹设置页：填你的服务器地址（`wss://…`）和口令。

## 选择分支

如果不确定该用哪个，选择 `main`。游戏分支完整包含 `main` 的功能，只额外增加游戏桥接，不是另一个独立版本。

| 分支 | 定位 | 额外要求 | 状态 |
|---|---|---|---|
| [`main`](https://github.com/tutusagi/viewfinder-share/tree/main) | 通用公开版：取景框、对话卡、截图、本地录屏、桌宠、主题和全屏托管 | Node.js；使用托管时需要 Windows | 默认稳定分支 |
| [`codex/game`](https://github.com/tutusagi/viewfinder-share/tree/codex/game) | 在 `main` 基础上增加星露谷本地游戏网关、游戏设置、MCP 工具和测试 | 星露谷、SMAPI、NagiBridge | 可选游戏分支 |

克隆通用版：

```bash
git clone --branch main https://github.com/tutusagi/viewfinder-share.git
```

克隆游戏版：

```bash
git clone --branch codex/game https://github.com/tutusagi/viewfinder-share.git
```

### 游戏分支的边界

- 游戏桥接仅连接本机 `localhost:7842–7849`，不会向局域网或公网开放端口；
- 游戏托管默认关闭，必须由用户在面板上手动开启，重启应用后不会自动恢复；
- 游戏操作不接管系统鼠标键盘；原有的全屏鼠标键盘托管仍是独立功能；
- 云端模型只接触 `game_observe` 和 `game_do` 两个受限工具，不会获得任意 HTTP、脚本或 Shell 能力；
- 安装和协议细节见游戏分支的 [`GAME_MCP.md`](https://github.com/tutusagi/viewfinder-share/blob/codex/game/GAME_MCP.md)。

## 接入你自己的 AI 后端

服务端要做的事很少：WS 鉴权、把 App 的 `chat`/`file` 交给你的 AI、把 AI 的回复用 `done` 推回去、再实现两个 localhost 内部端点供 MCP 驱动"AI 看屏幕/动鼠标"两个环。完整消息表、时序、超时建议、安全要求都在 [PROTOCOL.md](PROTOCOL.md)。

三条参考路线：

- **Anthropic API 直连** — 服务端自己维护对话数组，截图作 image block，把两个内部端点包装成 tool 放进工具循环（这条路不需要 MCP）。
- **Claude Code**（headless / Agent SDK）— 把 `mcp/index.js` 注册进 MCP 配置；工具用法靠 `mcp/SKILL.md` 作为 skill 承载。
- **Codex CLI** — 同样挂 `mcp/index.js`（stdio MCP），其余同上。

### mcp/ 目录的设计

MCP 工具描述**故意极简**（三个工具各一行，总共不到 100 token），全部使用说明放在 `mcp/SKILL.md` 里——常驻上下文只花一个 skill 描述的钱，细节在真正要用时才加载。接 Claude Code 时把它当 skill 装；接 API 时把 SKILL.md 内容并进系统提示即可。

## 安全须知

**托管功能 = 把鼠标键盘交给远端 AI**，请认真对待：

- 一定用 wss（TLS）+ 强口令；
- 保留"托管开关只能用户手动打开、Esc 随时退出"的设计；
- 服务端的两个内部端点必须只听 localhost（协议文档第 6 节有具体校验写法）；
- 给 AI 的提示词里写明：花钱、删除、发送类操作先问人。

## License

本项目采用 [MIT License](LICENSE)。
