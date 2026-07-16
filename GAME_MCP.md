# 星露谷本地 MCP 网关

Viewfinder 把 NagiBridge 留在本机，并只向聊天模型暴露两个紧凑工具。模型不会看到 NagiBridge 的端点清单，也不会在每轮携带几十份 MCP 描述。

```text
聊天模型（2 个工具）
  ↕ WebSocket: vf_tool_call / vf_tool_result
Viewfinder Electron 主进程
  ↕ 进程内 MCP
game_observe / game_do
  ↕ localhost HTTP
NagiBridge（SMAPI）
```

## 前置条件

1. 用 SMAPI 安装并启动 NagiBridge。
2. 进入一个存档，确认 SMAPI 控制台显示 NagiBridge HTTP server 已启动。
3. 在 Viewfinder 设置里保留端口 `0` 以自动扫描 `7842–7849`。多客户端时填写 AI 要控制的玩家名。
4. 点击面板上的“游戏”按钮。游戏托管默认关闭，重新启动 Viewfinder 后也不会自动开启。

关闭游戏托管会尝试调用 `/stop`。游戏操作不要求全屏，也不接管系统鼠标键盘；原来的全屏鼠标托管仍作为兜底能力保留。

## 模型工具面

聊天服务只需给模型注册以下两个工具。不要把本地 MCP 的 `tools/list` 或 NagiBridge 的端点说明转发给模型。

### `game_observe`

```json
{
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "enum": ["scene", "state", "nearby", "menu", "inventory", "machines", "animals", "alerts", "capabilities"]
    },
    "radius": { "type": "integer", "minimum": 1, "maximum": 20 }
  },
  "required": ["scope"],
  "additionalProperties": false
}
```

`scene` 在一次观察里返回紧凑状态、附近格子和临时游戏截图，是三段式操作的第一/第三轮。`capabilities` 只在模型不确定可用操作时按需查询，不要每轮调用。

### `game_do`

```json
{
  "type": "object",
  "properties": {
    "op": {
      "type": "string",
      "enum": ["move", "face", "select", "use", "interact", "choose", "key", "stop", "sequence"]
    },
    "x": { "type": "integer" },
    "y": { "type": "integer" },
    "name": { "type": "string", "maxLength": 80 },
    "direction": { "enum": [0, 1, 2, 3, "up", "right", "down", "left"] },
    "option": { "type": "integer", "minimum": 0, "maximum": 50 },
    "button": { "enum": ["ok", "cancel", "back", "forward", "close"] },
    "key": { "enum": ["confirm", "action", "ok", "menu", "cancel", "back", "skip"] },
    "steps": {
      "type": "array",
      "minItems": 1,
      "maxItems": 64,
      "description": "sequence 专用；每项只能是一个基础动作及其参数，可选 wait_ms 0–2000"
    }
  },
  "required": ["op"],
  "additionalProperties": false
}
```

参数约定：

- `move`：需要 `x`、`y`，网关会等待寻路结束再返回。
- `face`：需要 `direction`，数字含义是上、右、下、左；它瞬时设置最终朝向，连续调用只保留最后一次，不会播放“转圈”动画。
- `select`：需要物品 `name`。
- `use`：可带 `name`，网关会先选择该物品，再安全使用；不允许 `force`。
- `choose`：提供 `option` 或 `button`。
- `key`：只允许上面列出的游戏内安全按键。
- `interact`、`stop`：不需要额外参数。
- `sequence`：需要 `steps`。模型必须明确列出每个具体基础动作和目标格；不允许嵌套 sequence、范围目标或一键宏。

推荐固定为三轮：`game_observe(scene)` 看画面并形成完整计划 → 一次 `game_do(sequence)` 连续执行实际玩家动作 → 再次 `game_observe(scene)` 看结果。序列中途失败会返回已完成步骤和断点，服务端不得自动重放整串。

云端 MCP 门面应暴露上述完整 inputSchema。兼容旧客户端时，如果 `steps` 被错误序列化成 JSON 字符串，门面或本地网关会先安全解析为数组，再交给严格 schema 校验；其他非数组值仍拒绝。

## WebSocket 协议

聊天服务收到模型工具调用后，发送：

```json
{
  "type": "vf_tool_call",
  "requestId": "turn-42",
  "callId": "call-7",
  "tool": "game_do",
  "arguments": { "op": "move", "x": 42, "y": 18 },
  "capture": false
}
```

Viewfinder 返回：

```json
{
  "type": "vf_tool_result",
  "requestId": "turn-42",
  "callId": "call-7",
  "tool": "game_do",
  "ok": true,
  "result": {
    "action": "move",
    "settled": true,
    "state": {
      "player": { "position": [42, 18], "moving": false },
      "location": { "name": "Farm" }
    }
  },
  "desc": "走到了 (42, 18)"
}
```

当 `capture` 为 `true` 时，结果还会有 JPEG base64 的 `data`。聊天服务只应为 `game_observe(scope=scene)` 请求截图；`game_do` 不截图，以保持“观察 → 连续操作 → 观察”的三轮结构并减少视觉 token。

服务端必须用 `callId` 关联并等待结果，把 `result` 作为模型的 tool result 继续同一轮推理。失败时把 `error` 作为 tool result 交回模型，不要在服务端自动重试写操作。

### 旧协议兼容

尚未升级聊天服务时，可以继续下发已有的 `vf_action`：

```json
{
  "type": "vf_action",
  "requestId": "turn-42",
  "action": {
    "type": "game_do",
    "op": "interact"
  }
}
```

Viewfinder 会沿用 `vf_shot` 回复，并额外放入 `result` 字段。正式接入仍建议使用 `vf_tool_call / vf_tool_result`，因为观察操作不必伪装成截图。

## 上下文与安全策略

- `state` 默认不返回完整背包；背包单独用 `inventory` 查询。
- `nearby` 会删除只有 `diggable` 的普通地块，按距离排序并限制为 120 个有效格子。
- 操作结果只回传压缩状态，不回传原始整张地图。
- 不开放 `/warp`、`/position`、`/give`、`/money`、`/heal`、`/ripen`、`/refill`、任意脚本或 Shell。
- 不开放 `/harvest` 等一键改变多格世界状态的宏。模型必须观察并选择具体格子，再用移动、朝向、使用或互动逐格完成正常游戏动作。
- 同时只执行一个 `game_do` 调用；`sequence` 内按顺序执行最多 64 个显式基础动作。任何写操作都不会自动重试。
- 操作审计写入 Electron userData 下的 `game-actions.jsonl`。
- 目标端口只允许 `7842–7849`，HTTP 地址固定为 `localhost`（NagiBridge 的 Windows HttpListener 只接受这个 Host 前缀）。

NagiBridge 自身当前没有鉴权且允许宽松 CORS。Viewfinder 网关不会扩大监听范围，但长期建议在 NagiBridge fork 中增加随机会话令牌，并去掉不需要的浏览器 CORS。

## 真实 AI Farmhand

真正的独立玩家应运行第二个星露谷客户端，让它以 Farmhand 身份加入主机。两个客户端各自启动 NagiBridge，网关扫描端口后按 `/state.player.name` 选择设置中指定的玩家。端口是“先到先得”，不要假定 host 永远是 7842、Farmhand 永远是 7843。
