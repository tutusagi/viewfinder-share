# 取景框 · 主题说明书

主题是一个 JSON 文件，在面板「设置 → 主题」里导入/导出。
建议先点「导出主题」拿到当前外观的完整模板，改完再导入。

## 文件结构

```json
{
  "name": "主题名（导出文件名会用它）",
  "author": "作者",
  "day":   { "--变量": "值", ... },
  "night": { "--变量": "值", ... },
  "css": "附加 CSS（进阶，可留空字符串）"
}
```

- 7:00–19:00 用 `day` 段，其余时间用 `night` 段；不写 `night` 就全天用 `day`。
  **注意：晚上测主题时生效的是 `night` 段**——改了 `day` 看不到变化别以为没导入成功。
- 变量直接盖在默认外观上：只写你想改的几个也行，没写的保持默认。
- `css` 里的样式会同时注入取景框和面板两个窗口，选择器随便写（进阶玩法）。

## 变量清单

### 对话面板

| 变量 | 作用 |
|---|---|
| `--card` | 卡片底色 |
| `--line` | 描线（边框、分隔线、滚动条） |
| `--ink` | 正文文字色 |
| `--sub` | 次要文字色（状态、提示） |
| `--me-bg` | 「我」的气泡底色 |
| `--accent` | 强调色：AI 气泡左侧竖线、输入框焦点 |
| `--glow` | 卡片阴影/光晕（box-shadow 值） |
| `--radius` | 卡片圆角 |
| `--ui-font` | 界面字体 |
| `--ai-font` | AI 消息字体 |
| `--ai-weight` | AI 消息字重（默认 300，细体；想粗回去写 400 或 normal） |

### 小螃蟹（对话卡上沿的桌宠）

| 变量 | 作用 |
|---|---|
| `--pet-body` | 螃蟹壳色（默认 `#DE886D`，Clawd 原色） |
| `--pet-glow` | 螃蟹荧光（filter 值，默认白天 `none`、夜里淡青光） |

不想要螃蟹：在 `css` 里写 `"#petzone{display:none}"` 即可。

### 取景框

| 变量 | 作用 |
|---|---|
| `--frame-line` | 框线颜色（含四角角标、工具条胶囊描边） |
| `--frame-w` | 框线宽度（加粗做花边时截图会自动避开，不会截进画面） |
| `--frame-glow` | 框光晕（box-shadow 值） |
| `--frame-border-image` | 花边：完整的 border-image 简写值，见下方示例 |
| `--flash-color` | 快门闪光颜色（两个窗口都认它） |

## 花边（--frame-border-image）

`border-image` 可以用渐变直接画花纹，也可以贴图。贴图请用 data URI（把图片编码进主题文件，
这样一个 JSON 发给别人就是完整主题）。记得把 `--frame-w` 加宽到花边需要的宽度。

**渐变糖果纹（不用图片）：**

```json
"day": {
  "--frame-w": "10px",
  "--frame-border-image": "repeating-linear-gradient(45deg, #e8a2b8 0 8px, #fff8f4 8px 16px) 10 / 10px round"
}
```

**贴图花边（30 像素九宫格切法）：**

```json
"day": {
  "--frame-w": "14px",
  "--frame-border-image": "url(\"data:image/png;base64,……\") 30 / 14px round"
}
```

## 完整示例：樱花粉

```json
{
  "name": "樱花粉",
  "author": "you",
  "day": {
    "--card": "rgba(255,250,251,.97)",
    "--line": "#f3d9e0",
    "--ink": "#5a4a4f",
    "--sub": "#c4a8b0",
    "--me-bg": "#fdeef2",
    "--accent": "#e8a2b8",
    "--glow": "0 6px 24px rgba(232,162,184,.18)",
    "--frame-line": "#e8a2b8",
    "--frame-w": "10px",
    "--frame-border-image": "repeating-linear-gradient(45deg, #e8a2b8 0 8px, #fff8f4 8px 16px) 10 / 10px round",
    "--flash-color": "rgba(255,214,228,.95)"
  },
  "night": {
    "--card": "rgba(30,22,26,.96)",
    "--line": "#4a323c",
    "--ink": "#f0dde4",
    "--sub": "#8f6f7c",
    "--me-bg": "#382630",
    "--accent": "#e8a2b8",
    "--glow": "0 0 14px rgba(232,162,184,.30)",
    "--frame-line": "#e8a2b8",
    "--frame-w": "10px",
    "--frame-border-image": "repeating-linear-gradient(45deg, #e8a2b8 0 8px, #382630 8px 16px) 10 / 10px round",
    "--frame-glow": "0 0 10px rgba(232,162,184,.55)"
  },
  "css": ""
}
```

## 注意

- 颜色值就是普通 CSS：`#hex`、`rgba(...)`、渐变都行。
- 主题保存在 Electron 的 `userData` 目录下，文件名为 `theme.json`；「恢复默认」即删掉它。
- 布局尺寸（工具条高度、面板宽高、缩放热区）不开放主题化——它们和截图坐标、
  窗口逻辑绑在一起，改了会出功能性问题。想要的话提需求。
