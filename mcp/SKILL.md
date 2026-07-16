---
name: viewfinder
description: 取景框三件工具（peek_screen/capture_screen/control_screen）的完整用法——第一次用、想托管操作用户的电脑、或拿不准参数时先读这个
---

# 取景框（viewfinder）

> 用户桌面上有一个置顶小框，拖到哪、你就只能看到哪。框在哪、框多大都是用户定的——**框就是给你的许可范围**。App 关着就什么都看不到，那说明用户不在电脑前。

> 这份文件是 MCP 工具的唯一使用说明（工具描述故意极简）。作为 Claude Code skill 使用时，把整个目录放进 skills 目录即可；接 API 或其他后端时，把本文当系统提示材料喂给模型。

## 看：peek_screen 和 capture_screen

两个工具唯一的区别是**留不留档**：

- **peek_screen** — 瞥一眼，看完即焚。你会记得自己看过什么，但画面本身过一会儿就自动焚掉，不占对话空间。所以想看就看、不用省着用：用户工作时盯一眼进度、用户说"你看"的时候看过去，都是这个。
- **capture_screen** — 正式截一张，永远留在对话里。适合值得留住的时刻。留档占对话空间，值得留的再用。

两个都返回图片文件路径，用 Read 打开就能看到。截图瞬间取景框边缘会像快门一样轻轻闪一下光——用户在屏幕前就知道你看了。

## 动：control_screen（托管）

只有用户在取景框 App 的**全屏模式亲手打开"托管"开关**，这个工具才有效。

**基本环：看-动-看。** 坐标用你最近一次看到的那张截图上的像素位置（左上角 0,0）。每做完一个动作，会自动等界面反应、然后把操作后的新画面直接内联在结果里回给你（不用再 Read；看完即焚同 peek_screen）——你当场看到这一步的后果，接着决定下一步。

**等待（wait_ms）。** 界面往往不会瞬间响应：点了要加载的东西、弹窗、页面跳转都有延迟。wait_ms 指定"操作后等几毫秒再截图"，默认 600，慢的给 1500–8000，上限 10000。万一等完画面还没变：先 peek_screen 再看一眼，或下一步把 wait_ms 调更大。

**批量（steps）。** 当你能从当前画面直接预测出接下来每一步的坐标时（"移到某处→从这拖到那→点某个固定按钮"这种位置全已知的连招），把动作按顺序放进 steps 数组（最多 12 步），一次调用全做完、只在最后回一张图。传了 steps 就忽略顶层的 action/x/y。步与步之间默认停 150ms，某步会让界面动一下就给那步单独调大 wait_ms。打字连招也能放这：click 输入框 → type_text → press_key enter。
反过来，**只要下一步的位置得等这一步的结果才知道**（等菜单弹出、列表加载、页面跳转），就别硬猜：单步做完、看了新画面再决定。拿不准就一步一步来，稳比快重要。

**打字。**
- `type_text`（用 text 参数）：直接输入一段文字，中英文/emoji 都行，绕过输入法。
- `press_key`（用 key，可配 mods）：功能键或组合键。key 可以是 enter/tab/backspace/delete/esc/space/up/down/left/right/home/end/f1…f12 或单个字母数字；mods 是同时按住的修饰键，如 ["ctrl"]、["ctrl","shift"]、["alt"]、["win"]。
- 打字前通常要先 click 一下目标输入框让它获得焦点，再 type_text。这两个动作不需要 x/y 坐标。

**动作一览：** move 只移过去不点 / click 单击 / double_click 双击 / right_click 右键 / drag 按住从 (x,y) 拖到 (x2,y2) / scroll 在 (x,y) 处滚滚轮（amount 正上负下，默认 -3）/ type_text 打字 / press_key 按键。

## 参数速查（MCP 那边没写 schema，参数名以这里为准）

peek_screen 和 capture_screen 无参数。control_screen 的参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `action` | string | 动作名，取值见上面动作一览（move/click/double_click/right_click/drag/scroll/type_text/press_key） |
| `x`, `y` | number | 目标像素坐标（type_text/press_key 不需要） |
| `x2`, `y2` | number | drag 专用：终点 |
| `amount` | number | scroll 专用：格数，正上负下 |
| `text` | string | type_text 专用 |
| `key` | string | press_key 专用：键名 |
| `mods` | string[] | press_key 专用：修饰键，如 `["ctrl","shift"]` |
| `wait_ms` | number | 操作后等多久截图（毫秒，默认 600，上限 10000） |
| `steps` | object[] | 批量连招，每步 `{type, ...同上参数, wait_ms}`；传了 steps 就忽略顶层 action/x/y |

单步例：`{"action":"click","x":420,"y":310,"wait_ms":1500}`
批量例：`{"steps":[{"type":"click","x":420,"y":310},{"type":"type_text","text":"你好"},{"type":"press_key","key":"enter"}]}`

## 规矩

动作要轻，一次一步，看清楚再动。拿不准的地方——**要花钱的、要删东西的、要发出去的——先问用户，不要替用户按下去。**
