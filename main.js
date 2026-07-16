// 取景框 — 主进程
// 两个窗口：frame（透明置顶的取景框，内部点击穿透）+ panel（旁边的迷你对话卡）。
// 截图在主进程做：desktopCapturer 抓整屏 → 裁到框内 → 压缩（长边 ≤1568、JPEG q80，超 800KB 降 q65）。
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, dialog, globalShortcut, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// 布局常量：必须与 frame.html 的 CSS 一致，截图按它算框内区域
const TOOLBAR_H = 32;      // 顶部工具条高度（在框外面）
let frameInset = 3;        // 框线实际宽度（主题可改花边/线宽，渲染进程量好实测值报上来）
const PET_H = 48;          // 面板顶部的透明"螃蟹地带"：小螃蟹趴在对话卡上沿
const PANEL_W = 300, PANEL_H = 380 + PET_H, GAP = 12;
const MIN_W = 200, MIN_H = 160;

let conf = {
  server: "",
  token: "",
  aiName: "",     // 对方（AI）的显示名，界面文案用；空 = 前端用中性默认「TA」
  locked: false,
  frame: { x: null, y: null, w: 520, h: 380 },
  // 公用渲染设置：split=气泡分割符（空=不分割）；strip=剥离标签列表（空格分隔，如 【记忆】 <think>）
  render: { split: "|||", strip: "【记忆】 【心情】 【状态】" },
  hotkeyFull: "Ctrl+Alt+F",   // 全屏切换全局快捷键（Electron accelerator 格式，空=不注册）
};
const confPath = () => path.join(app.getPath("userData"), "config.json");
function loadConf() {
  try { conf = { ...conf, ...JSON.parse(fs.readFileSync(confPath(), "utf8")) }; } catch (_) {}
}
function saveConf() {
  try { fs.writeFileSync(confPath(), JSON.stringify(conf, null, 2)); } catch (_) {}
}

let frameWin = null, panelWin = null;
let isFullscreen = false;
// 框的"逻辑真值"坐标：拖动/缩放只改它、再写给窗口，绝不 getBounds 回读——
// Windows 非 100% 缩放下 get/setBounds 往返会像素取整漂移，越拖越大（1.1.0 实测坑）
let fb = { x: 0, y: 0, w: 520, h: 380 };
const fbBounds = () => ({ x: Math.round(fb.x), y: Math.round(fb.y), width: Math.round(fb.w), height: Math.round(fb.h) });
function applyFb() { if (frameWin) frameWin.setBounds(fbBounds()); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const intersects = (a, b) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

// 内置默认外观的主题化表达：没导入过主题时，"导出主题"给的就是它——改起来最方便的模板
const DEFAULT_THEME = {
  name: "默认·昼白夜荧",
  author: "tutusagi",
  day: {
    "--card": "rgba(255,255,255,.96)", "--line": "#e8e6e2", "--ink": "#333", "--sub": "#9a968f",
    "--me-bg": "#f2f0ec", "--accent": "#2b2b2b", "--glow": "0 6px 24px rgba(0,0,0,.10)",
    "--radius": "16px", "--flash-color": "rgba(255,255,255,.9)",
    "--frame-line": "#9fe8e0", "--frame-w": "3px",
    "--frame-glow": "0 0 10px rgba(159,232,224,.55)", "--frame-border-image": "none",
    "--pet-body": "#DE886D", "--pet-glow": "none",
    "--ui-font": '"幼圆", "YouYuan", "Microsoft YaHei UI", sans-serif',
    "--ai-font": '"Source Han Sans SC Light", "Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei UI Light", "Microsoft YaHei UI", sans-serif',
    "--ai-weight": "300",
  },
  night: {
    "--card": "rgba(16,20,24,.96)", "--line": "#243032", "--ink": "#dfe8e6", "--sub": "#6b7f7c",
    "--me-bg": "#1b2427", "--accent": "#9fe8e0", "--glow": "0 0 14px rgba(159,232,224,.28)",
    "--radius": "16px", "--flash-color": "rgba(255,255,255,.9)",
    "--frame-line": "#9fe8e0", "--frame-w": "3px",
    "--frame-glow": "0 0 10px rgba(159,232,224,.55)", "--frame-border-image": "none",
    "--pet-body": "#DE886D", "--pet-glow": "drop-shadow(0 0 3px rgba(159,232,224,.35))",
    "--ui-font": '"幼圆", "YouYuan", "Microsoft YaHei UI", sans-serif',
    "--ai-font": '"Source Han Sans SC Light", "Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei UI Light", "Microsoft YaHei UI", sans-serif',
    "--ai-weight": "300",
  },
  css: "",
};

// 面板贴在框右侧，放不下就换左侧；上缘对齐工具条下方（全屏时解除吸附，面板自由飞）
function placePanel() {
  if (!frameWin || !panelWin || isFullscreen) return;
  const b = frameWin.getBounds();   // 原生拖拽期间 fb 还没同步，跟随要用实时位置（只读不写回，无漂移）
  const disp = screen.getDisplayMatching(b);
  const wa = disp.workArea;
  let x = b.x + b.width + GAP;
  if (x + PANEL_W > wa.x + wa.width) x = b.x - GAP - PANEL_W;
  let y = b.y + TOOLBAR_H - PET_H;   // 上移螃蟹地带的高度，卡片本体仍与工具条下缘对齐
  if (y + PANEL_H > wa.y + wa.height) y = wa.y + wa.height - PANEL_H;
  y = Math.max(wa.y, y);
  panelWin.setBounds({ x: Math.round(x), y: Math.round(y), width: PANEL_W, height: PANEL_H });
}

function createWindows() {
  const disp = screen.getPrimaryDisplay().workArea;
  const f = conf.frame;
  const x = f.x == null ? Math.round(disp.x + disp.width - f.w - PANEL_W - GAP * 3) : f.x;
  const y = f.y == null ? Math.round(disp.y + 80) : f.y;
  fb = { x, y, w: f.w, h: f.h };

  frameWin = new BrowserWindow({
    x, y, width: f.w, height: f.h,
    transparent: true, frame: false, resizable: false, movable: true,   // movable：边线/胶囊走原生拖拽（丝滑）
    skipTaskbar: true, hasShadow: false, minimizable: false, maximizable: false,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  frameWin.setAlwaysOnTop(true, "screen-saver");
  frameWin.loadFile("frame.html");
  frameWin.setIgnoreMouseEvents(true, { forward: true });
  _lastIgnore = true;

  panelWin = new BrowserWindow({
    width: PANEL_W, height: PANEL_H,
    transparent: true, frame: false, resizable: false, movable: false,
    skipTaskbar: true, hasShadow: false, minimizable: false, maximizable: false,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  panelWin.setAlwaysOnTop(true, "screen-saver");
  panelWin.loadFile("panel.html");

  frameWin.on("move", placePanel);
  frameWin.on("resize", placePanel);
  // 原生拖拽结束：把真实位置认领回逻辑坐标 fb 并落盘。
  // 阈值 >2px：applyFb 自己触发的 moved（缩放路径）最多差 1px 取整，不认领——认领了就把
  // 读回写循环重新接上、漂移复活；用户真拖动的位移远大于 2px
  frameWin.on("moved", () => {
    const r = frameWin.getBounds();
    if (Math.abs(r.x - fb.x) > 2 || Math.abs(r.y - fb.y) > 2) {
      fb.x = r.x; fb.y = r.y;
      if (!isFullscreen) {
        const b = fbBounds();
        conf.frame = { x: b.x, y: b.y, w: b.width, h: b.height };
        saveConf();
      }
    }
  });
  placePanel();

  frameWin.on("closed", () => { frameWin = null; if (panelWin) panelWin.close(); });
  panelWin.on("closed", () => { panelWin = null; });

  // 锁定/主题状态：加载完同步给两个窗口（都记在磁盘上，重启不丢）
  frameWin.webContents.on("did-finish-load", () => { sendLock(); sendTheme(); sendFullscreen(); });
  panelWin.webContents.on("did-finish-load", () => { sendLock(); sendTheme(); sendFullscreen(); });
}

function sendLock() {
  if (frameWin) frameWin.webContents.send("vf-lock", !!conf.locked);
  if (panelWin) panelWin.webContents.send("vf-lock", !!conf.locked);
}

// ── 穿透开关：主进程轮询光标位置按几何判定 ──
// 1.1.2 教训：-webkit-app-region: drag 的元素不给页面发鼠标事件，靠 mouseover 解除穿透
// 的方案在拖拽区上彻底失效（拖不动+全穿透）。所以这里不依赖渲染进程：每 60ms 查一次
// 光标，压在胶囊/边线带/四角上就解除穿透（原生拖拽由此能接到 mousedown），否则穿透。
let pillW = 250;              // 胶囊实际宽度，渲染进程量好上报
let rendererDragging = false; // 四角缩放 pointer-capture 期间锁定"不穿透"
let _lastIgnore = null;
function setIgnore(v) {
  if (!frameWin || v === _lastIgnore) return;
  _lastIgnore = v;
  frameWin.setIgnoreMouseEvents(v, { forward: true });
}
setInterval(() => {
  if (!frameWin || isFullscreen || !frameWin.isVisible()) return;
  if (rendererDragging) return setIgnore(false);
  // 用实时 getBounds（只读不写回，无漂移问题）：原生拖拽进行中 fb 是旧值，实时值才跟手
  const b = frameWin.getBounds();
  const p = screen.getCursorScreenPoint();
  const B = Math.max(frameInset, 6) + 4;   // 判定带比框线略宽，好瞄
  const fy = b.y + TOOLBAR_H;              // 框体上缘（工具条下方）
  const inPill = p.x >= b.x && p.x <= b.x + pillW + 14 && p.y >= b.y && p.y < fy;
  let hot = inPill;
  if (!hot && !conf.locked) {
    const inFrame = p.x >= b.x - 4 && p.x <= b.x + b.width + 4 && p.y >= fy - 4 && p.y <= b.y + b.height + 4;
    const inInterior = p.x > b.x + B && p.x < b.x + b.width - B && p.y > fy + B && p.y < b.y + b.height - B;
    const G = 28;
    const inCorner = inFrame && (p.x <= b.x + G || p.x >= b.x + b.width - G) && (p.y <= fy + G || p.y >= b.y + b.height - G);
    hot = (inFrame && !inInterior) || inCorner;
  }
  setIgnore(!hot);
}, 60);

// ── 全屏：取景框整个隐身（AI 可看整屏，桌面上零遮挡），控制入口挪到面板头部；
//    面板解除吸附自由拖；退出全屏框原地现身、面板归位 ──
function setFullscreen(v) {
  if (!frameWin || v === isFullscreen) return;
  isFullscreen = v;
  if (v) {
    frameWin.hide();
  } else {
    setTakeover(false, "退出了全屏");   // 托管跟全屏绑定，退出即断
    applyFb();               // 框的逻辑坐标没动过，直接现身
    frameWin.showInactive();
    placePanel();
  }
  sendFullscreen();
}
function sendFullscreen() {
  if (frameWin) frameWin.webContents.send("vf-fullscreen", isFullscreen);
  if (panelWin) panelWin.webContents.send("vf-fullscreen", isFullscreen);
}

// ── 托管：全屏模式下用户手动打开，AI 才可以动鼠标 ──
// 注入靠一个常驻 PowerShell 子进程调 user32 SendInput（零原生依赖，portable 包不受影响）。
// 坐标链：AI 报"它看到的那张截图上的像素" → 按截图时记下的映射换算回屏幕 DIP →
// dipToScreenPoint 换算物理像素 → SendInput 用虚拟桌面归一化坐标落点（DPI/多屏都不漂）。
// 安全阀：只在全屏+托管开时接指令；退出全屏自动断；退出托管按 Esc / 点面板按钮 / 退全屏。
// 注：不硬锁用户的鼠标——真正的锁需要装全局鼠标钩子，那是键盘记录器的典型特征，会被
// Windows Defender 静态判毒直接删掉 exe(0714 实测 1.2.3 中招，换回软方案)。软方案：删掉
// 过敏的"碰鼠标自动断"，靠绝对坐标(用户偶尔碰不影响 AI 落点) + 提示操作时先别碰。
let takeover = false;
let lastShotMap = null;   // 最近一次截图的映射：{ interior(DIP), imgW, imgH }
let actionBusy = false;
let psProc = null, psPending = new Map(), psSeq = 0, psBuf = "";

// PowerShell 常驻输入器：stdin 一行一个 JSON 指令，stdout 一行一个 JSON 结果。
// 注意：这段是 PS 代码，别在里面用反引号（PS 转义符）和 ${}（JS 模板会吃掉）。
const PS_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class VF {',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
  '  // INPUT 是联合体：鼠标/键盘共用同一段内存（x64 下 union 在偏移 8），mi 和 ki 重叠',
  '  [StructLayout(LayoutKind.Explicit)]',
  '  public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; }',
  '  [DllImport("user32.dll", SetLastError = true)]',
  '  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);',
  '  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '  // 在 C# 里构造并发送事件——PowerShell 改结构体字段是值类型拷贝、写不回去（0714 坑）',
  '  public static uint MouseEvent(uint flags, int dx, int dy, int data) {',
  '    INPUT[] inp = new INPUT[1];',
  '    inp[0].type = 0;',
  '    inp[0].mi.dx = dx; inp[0].mi.dy = dy;',
  '    inp[0].mi.mouseData = (uint)data;',
  '    inp[0].mi.dwFlags = flags;',
  '    return SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));',
  '  }',
  '  // 打字：wScan=Unicode 码元 + KEYEVENTF_UNICODE，直接输入字符、绕过键盘布局和输入法',
  '  public static uint KeyUnicode(ushort ch, uint flags) {',
  '    INPUT[] inp = new INPUT[1];',
  '    inp[0].type = 1;',
  '    inp[0].ki.wScan = ch; inp[0].ki.dwFlags = flags;',
  '    return SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));',
  '  }',
  '  // 功能键/组合键：按虚拟键码（VK_*），flags 0=按下 2=抬起',
  '  public static uint KeyVk(ushort vk, uint flags) {',
  '    INPUT[] inp = new INPUT[1];',
  '    inp[0].type = 1;',
  '    inp[0].ki.wVk = vk; inp[0].ki.dwFlags = flags;',
  '    return SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));',
  '  }',
  '}',
  '"@',
  '[VF]::SetProcessDPIAware() | Out-Null',
  'function Send-M([uint32]$flags, [int]$dx, [int]$dy, [int]$data) {',
  '  if ([VF]::MouseEvent($flags, $dx, $dy, $data) -ne 1) { throw "SendInput failed" }',
  '}',
  '# 绝对移动：虚拟桌面归一化坐标（0-65535），MOVE|ABSOLUTE|VIRTUALDESK = 0xC001',
  'function Move-Abs([int]$px, [int]$py) {',
  '  $vx = [VF]::GetSystemMetrics(76); $vy = [VF]::GetSystemMetrics(77)',
  '  $vw = [VF]::GetSystemMetrics(78); $vh = [VF]::GetSystemMetrics(79)',
  '  $nx = [int][Math]::Round((($px - $vx) * 65535.0) / [Math]::Max(1, $vw - 1))',
  '  $ny = [int][Math]::Round((($py - $vy) * 65535.0) / [Math]::Max(1, $vh - 1))',
  '  Send-M 0xC001 $nx $ny 0',
  '}',
  'function Click-At([int]$px, [int]$py, [uint32]$down, [uint32]$up) {',
  '  Move-Abs $px $py; Start-Sleep -Milliseconds 40',
  '  Send-M $down 0 0 0; Start-Sleep -Milliseconds 30; Send-M $up 0 0 0',
  '}',
  '# 打字：Node 端已把文字拆成 UTF-16 码元数字数组（纯 ASCII 过管道、不受 stdin 编码影响，',
  '# 避开 Node UTF-8 写 vs PowerShell 代码页读的中文乱码坑），这里逐个用 UNICODE 方式敲',
  'function Type-Codes($codes) {',
  '  if (-not $codes) { return }',
  '  foreach ($code in $codes) {',
  '    $u = [uint16]$code',
  '    [VF]::KeyUnicode($u, 0x0004) | Out-Null',
  '    [VF]::KeyUnicode($u, 0x0006) | Out-Null',
  '    Start-Sleep -Milliseconds 4',
  '  }',
  '}',
  '# 名字 → 虚拟键码（VK）；单个字母/数字直接取字符码',
  '$VK = @{ enter=0x0D; return=0x0D; tab=0x09; backspace=0x08; back=0x08; delete=0x2E; del=0x2E; escape=0x1B; esc=0x1B; space=0x20; up=0x26; down=0x28; left=0x25; right=0x27; home=0x24; end=0x23; pageup=0x21; pagedown=0x22; ctrl=0x11; control=0x11; shift=0x10; alt=0x12; win=0x5B; f1=0x70; f2=0x71; f3=0x72; f4=0x73; f5=0x74; f6=0x75; f7=0x76; f8=0x77; f9=0x78; f10=0x79; f11=0x7A; f12=0x7B }',
  'function VkOf([string]$name) {',
  '  $k = ([string]$name).ToLower().Trim()',
  '  if ($VK.ContainsKey($k)) { return [uint16]$VK[$k] }',
  '  if ($k.Length -eq 1) { return [uint16][int][char]($k.ToUpper()) }',
  '  throw ("unknown key: " + $name)',
  '}',
  '# 组合键：先按下所有修饰键 → 敲主键 → 逆序抬修饰键',
  'function Press-Key([string]$name, $mods) {',
  '  $down = @()',
  '  if ($mods) { foreach ($m in $mods) { $mv = VkOf $m; [VF]::KeyVk($mv, 0) | Out-Null; $down += $mv } }',
  '  $vk = VkOf $name',
  '  [VF]::KeyVk($vk, 0) | Out-Null; Start-Sleep -Milliseconds 20; [VF]::KeyVk($vk, 0x0002) | Out-Null',
  '  if ($down.Count) { [array]::Reverse($down); foreach ($mv in $down) { [VF]::KeyVk($mv, 0x0002) | Out-Null } }',
  '}',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  '  $line = $line.Trim(); if (!$line) { continue }',
  '  $c = $null; $res = ""',
  '  try {',
  '    $c = $line | ConvertFrom-Json',
  '    switch ([string]$c.op) {',
  '      "ping" { }',
  '      "type_text" { Type-Codes $c.codes }',
  '      "press_key" { Press-Key ([string]$c.key) $c.mods }',
  '      "move" { Move-Abs $c.x $c.y }',
  '      "click" { Click-At $c.x $c.y 0x0002 0x0004 }',
  '      "right_click" { Click-At $c.x $c.y 0x0008 0x0010 }',
  '      "double_click" { Click-At $c.x $c.y 0x0002 0x0004; Start-Sleep -Milliseconds 60; Click-At $c.x $c.y 0x0002 0x0004 }',
  '      "scroll" { Move-Abs $c.x $c.y; Start-Sleep -Milliseconds 40; Send-M 0x0800 0 0 ([int]$c.amount * 120) }',
  '      "drag" {',
  '        Move-Abs $c.x $c.y; Start-Sleep -Milliseconds 120',
  '        Send-M 0x0002 0 0 0; Start-Sleep -Milliseconds 120',
  '        for ($k = 1; $k -le 16; $k++) {',
  '          $mx = [int]($c.x + ($c.x2 - $c.x) * $k / 16.0)',
  '          $my = [int]($c.y + ($c.y2 - $c.y) * $k / 16.0)',
  '          Move-Abs $mx $my; Start-Sleep -Milliseconds 15',
  '        }',
  '        Start-Sleep -Milliseconds 80; Send-M 0x0004 0 0 0',
  '      }',
  '      default { throw ("unknown op: " + $c.op) }',
  '    }',
  '    $res = \'{"id":\' + [int]$c.id + \',"ok":true}\'',
  '  } catch {',
  '    $eid = 0; if ($c -and $c.id) { $eid = [int]$c.id }',
  '    $res = \'{"id":\' + $eid + \',"ok":false,"error":\' + (ConvertTo-Json ([string]$_)) + \'}\'',
  '  }',
  '  [Console]::Out.WriteLine($res)',
  '  [Console]::Out.Flush()',
  '}',
].join("\r\n");

function stopInputHelper() {
  if (psProc) { try { psProc.kill(); } catch (_) {} psProc = null; }
  for (const [, p] of psPending) { clearTimeout(p.timer); p.reject(new Error("输入通道已关闭")); }
  psPending.clear(); psBuf = "";
}

function psCmd(cmd, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (!psProc || !psProc.stdin.writable) return reject(new Error("输入通道未就绪"));
    const id = ++psSeq;
    const timer = setTimeout(() => { psPending.delete(id); reject(new Error("注入超时")); }, timeoutMs);
    psPending.set(id, { resolve, reject, timer });
    psProc.stdin.write(JSON.stringify({ ...cmd, id }) + "\n");
  });
}

function ensureInputHelper() {
  if (psProc) return Promise.resolve();
  if (process.platform !== "win32") return Promise.reject(new Error("托管只支持 Windows"));
  const sp = path.join(app.getPath("userData"), "vf-input.ps1");
  try { fs.writeFileSync(sp, PS_SCRIPT); } catch (e) { return Promise.reject(e); }
  psProc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", sp], { windowsHide: true });
  psProc.on("exit", () => { psProc = null; if (takeover) setTakeover(false, "输入通道意外退出"); });
  psProc.on("error", () => { psProc = null; });
  psProc.stdout.on("data", (d) => {
    psBuf += d.toString();
    let i;
    while ((i = psBuf.indexOf("\n")) >= 0) {
      const line = psBuf.slice(0, i).trim(); psBuf = psBuf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (_) { continue; }
      const p = psPending.get(m.id);
      if (p) { psPending.delete(m.id); clearTimeout(p.timer); m.ok ? p.resolve() : p.reject(new Error(m.error || "注入失败")); }
    }
  });
  // 首条 ping 等 Add-Type 编译（第一次要一两秒）
  return psCmd({ op: "ping" }, 15000);
}

async function setTakeover(v, reason) {
  v = !!v;
  if (v === takeover) return { ok: true };
  if (v) {
    if (!isFullscreen) return { ok: false, error: "托管只在全屏模式下可用" };
    try { await ensureInputHelper(); } catch (e) { stopInputHelper(); return { ok: false, error: e.message }; }
    takeover = true;
    registerEscExit(true);   // Esc 随时停（面板按钮也能停；不锁鼠标，两者都可点）
  } else {
    takeover = false;
    registerEscExit(false);
    stopInputHelper();
  }
  sendTakeover(reason);
  return { ok: true };
}
function sendTakeover(reason) {
  if (panelWin) panelWin.webContents.send("vf-takeover", { on: takeover, reason: reason || "" });
}

// Esc 退出托管：只在托管期间注册（平时不占用 Esc），键盘不被钩子拦，所以一定按得到
function registerEscExit(on) {
  try {
    if (on) globalShortcut.register("Escape", () => setTakeover(false, "你按了 Esc 退出托管"));
    else globalShortcut.unregister("Escape");
  } catch (_) {}
}

// 图上像素 → 屏幕坐标。像素中心 +0.5 再换算，越界先夹回图内。
function mapToScreen(ix, iy) {
  const m = lastShotMap;
  if (!m) throw new Error("还没有可对照的截图");
  const cx = Math.min(Math.max(ix, 0), m.imgW - 1), cy = Math.min(Math.max(iy, 0), m.imgH - 1);
  const dip = {
    x: Math.round(m.interior.x + ((cx + 0.5) / m.imgW) * m.interior.width),
    y: Math.round(m.interior.y + ((cy + 0.5) / m.imgH) * m.interior.height),
  };
  const phys = typeof screen.dipToScreenPoint === "function" ? screen.dipToScreenPoint(dip) : dip;
  return { dip, phys };
}

// 全屏切换全局快捷键（系统级，窗口没焦点也响应——全屏后框隐身，全靠它和面板头部按钮退出）
function registerHotkey() {
  globalShortcut.unregisterAll();
  if (takeover) registerEscExit(true);   // unregisterAll 会连 Esc 一起清掉，托管中要补回
  const acc = String(conf.hotkeyFull || "").trim();
  if (!acc) return true;
  try {
    return globalShortcut.register(acc, () => setFullscreen(!isFullscreen));
  } catch (_) { return false; }
}

// ── 主题：userData/theme.json 是当前生效主题；没有 = 内置默认外观（发 null）──
const themePath = () => path.join(app.getPath("userData"), "theme.json");
function loadTheme() {
  try { return JSON.parse(fs.readFileSync(themePath(), "utf8")); } catch (_) { return null; }
}
function sendTheme() {
  const t = loadTheme();
  if (frameWin) frameWin.webContents.send("vf-theme", t);
  if (panelWin) panelWin.webContents.send("vf-theme", t);
}

// ── 截图：抓框所在屏幕 → 裁框内 → 压缩 ──
async function captureInterior() {
  const b = fbBounds();
  const disp = screen.getDisplayMatching(b);
  const B = frameInset;
  // 全屏模式：目标 = 整个屏幕；普通模式：框内区域（避开框线和工具条）
  const interior = isFullscreen ? { ...disp.bounds } : {
    x: b.x + B,
    y: b.y + TOOLBAR_H + B,
    width: b.width - B * 2,
    height: b.height - TOOLBAR_H - B * 2,
  };
  if (interior.width < 10 || interior.height < 10) throw new Error("框内区域太小");
  // 会入镜的自家窗口先闪避：全屏时框和面板都藏；普通模式面板压进框内也藏
  const toHide = [];
  if (isFullscreen) {
    if (frameWin.isVisible()) toHide.push(frameWin);
    if (panelWin && panelWin.isVisible()) toHide.push(panelWin);
  } else if (panelWin && panelWin.isVisible() && intersects(panelWin.getBounds(), interior)) {
    toHide.push(panelWin);
  }
  try {
    if (toHide.length) { toHide.forEach((w) => w.hide()); await sleep(160); }
    return await captureRegion(disp, interior);
  } finally {
    toHide.forEach((w) => w.showInactive());
  }
}

async function captureRegion(disp, interior) {
  const sf = disp.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(disp.size.width * sf),
      height: Math.round(disp.size.height * sf),
    },
  });
  // 选屏：display_id 精确匹配优先；失配时按显示器枚举顺序对位（Windows 多屏 display_id 偶发为空）
  let src = sources.find((s) => String(s.display_id) === String(disp.id));
  if (!src && sources.length > 1) {
    const idx = screen.getAllDisplays().findIndex((d) => d.id === disp.id);
    if (idx >= 0 && idx < sources.length) src = sources[idx];
  }
  if (!src) src = sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error("抓不到屏幕画面");
  let img = src.thumbnail;
  const full = img.getSize();
  // 诊断日志：截到奇怪画面时看这里（config.json 同目录 capture.log）
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "capture.log"), JSON.stringify({
      t: new Date().toISOString(),
      frame: frameWin ? frameWin.getBounds() : null, fullscreen: isFullscreen, interior,
      display: { id: disp.id, bounds: disp.bounds, size: disp.size, scaleFactor: disp.scaleFactor },
      sources: sources.map((s) => ({ id: s.id, name: s.name, display_id: s.display_id })),
      picked: { id: src.id, display_id: src.display_id },
      thumb: full,
    }) + "\n");
  } catch (_) {}
  // 缩放系数按实际抓到的像素算（有些机器 thumbnail 尺寸和请求值有出入）；
  // 普通模式内缩 1px 防框线入镜，全屏（窗口已闪避）不缩
  const kx = full.width / disp.size.width, ky = full.height / disp.size.height;
  const pad = isFullscreen ? 0 : 1;
  const crop = {
    x: Math.max(0, Math.round((interior.x - disp.bounds.x) * kx) + pad),
    y: Math.max(0, Math.round((interior.y - disp.bounds.y) * ky) + pad),
    width: Math.max(1, Math.round(interior.width * kx) - pad * 2),
    height: Math.max(1, Math.round(interior.height * ky) - pad * 2),
  };
  crop.width = Math.min(crop.width, full.width - crop.x);
  crop.height = Math.min(crop.height, full.height - crop.y);
  img = img.crop(crop);
  // 压缩：长边超 1568 等比缩（Claude 视觉最佳上限，再大也看不更清），JPEG q80，超 800KB 降 q65
  const sz = img.getSize();
  const maxSide = Math.max(sz.width, sz.height);
  if (maxSide > 1568) {
    img = sz.width >= sz.height ? img.resize({ width: 1568 }) : img.resize({ height: 1568 });
  }
  // 记下这张图的坐标映射（托管点击按它换算回屏幕位置），imgW/imgH 是压缩后的最终尺寸
  const outSz = img.getSize();
  lastShotMap = { interior: { ...interior }, imgW: outSz.width, imgH: outSz.height };
  let jpg = img.toJPEG(80);
  if (jpg.length > 800 * 1024) jpg = img.toJPEG(65);
  return jpg.toString("base64");
}

// ── IPC ──
app.whenReady().then(() => {
  loadConf();

  ipcMain.on("vf-ignore", (_e, ignore) => setIgnore(!!ignore));
  ipcMain.on("vf-dragging", (_e, v) => { rendererDragging = !!v; if (v) setIgnore(false); });
  ipcMain.on("vf-pill-w", (_e, w) => { const n = Number(w); if (Number.isFinite(n) && n > 40 && n < 600) pillW = Math.ceil(n); });

  ipcMain.on("vf-lock-set", (_e, v) => {
    conf.locked = !!v;
    saveConf();
    sendLock();
  });

  ipcMain.on("vf-inset", (_e, px) => {
    const n = Number(px);
    if (Number.isFinite(n) && n >= 1 && n <= 64) frameInset = Math.round(n);
  });

  ipcMain.handle("theme-import", async () => {
    const r = await dialog.showOpenDialog(panelWin, {
      title: "导入主题", filters: [{ name: "主题", extensions: ["json", "txt"] }, { name: "全部文件", extensions: ["*"] }], properties: ["openFile"],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    try {
      // 宽容解析：剥 BOM（记事本另存的 UTF-8 常带）、剥 Markdown 代码围栏（从 THEME.md 复制时容易带上）
      let raw = fs.readFileSync(r.filePaths[0], "utf8").replace(/^\uFEFF/, "").trim();
      raw = raw.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
      const t = JSON.parse(raw);
      if (!t || typeof t !== "object" || (!t.day && !t.night && !t.css)) return { error: "不是有效的主题文件（缺 day/night/css）" };
      fs.writeFileSync(themePath(), JSON.stringify(t, null, 2));
      sendTheme();
      return { ok: true, name: t.name || "" };
    } catch (e) { return { error: e.message }; }
  });

  ipcMain.handle("theme-export", async () => {
    const cur = loadTheme() || DEFAULT_THEME;
    const r = await dialog.showSaveDialog(panelWin, {
      title: "导出主题", defaultPath: (cur.name || "theme") + ".json",
      filters: [{ name: "主题", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    try { fs.writeFileSync(r.filePath, JSON.stringify(cur, null, 2)); return { ok: true, path: r.filePath }; }
    catch (e) { return { error: e.message }; }
  });

  ipcMain.on("theme-reset", () => {
    try { fs.unlinkSync(themePath()); } catch (_) {}
    frameInset = 3;
    sendTheme();
  });

  // 面板自由位置的逻辑真值（全屏时用），同样只写不读防漂移
  let pb = null;
  ipcMain.on("vf-move-by", (e, { dx, dy }) => {
    if (conf.locked) return;
    // 全屏时：面板的拖动移面板自己（自由飞），框冻结不动
    if (isFullscreen) {
      if (panelWin && e.sender === panelWin.webContents) {
        if (!pb) { const p = panelWin.getBounds(); pb = { x: p.x, y: p.y }; }
        pb.x += dx; pb.y += dy;
        panelWin.setBounds({ x: Math.round(pb.x), y: Math.round(pb.y), width: PANEL_W, height: PANEL_H });
      }
      return;
    }
    pb = null;
    fb.x += dx; fb.y += dy;
    applyFb();
  });

  ipcMain.on("vf-resize-by", (_e, { edge, dx, dy }) => {
    if (!frameWin || conf.locked || isFullscreen) return;
    if (edge.includes("e")) fb.w += dx;
    if (edge.includes("s")) fb.h += dy;
    if (edge.includes("w")) { fb.x += dx; fb.w -= dx; }
    if (edge.includes("n")) { fb.y += dy; fb.h -= dy; }
    if (fb.w < MIN_W) { if (edge.includes("w")) fb.x -= MIN_W - fb.w; fb.w = MIN_W; }
    if (fb.h < MIN_H) { if (edge.includes("n")) fb.y -= MIN_H - fb.h; fb.h = MIN_H; }
    applyFb();
  });

  ipcMain.on("vf-geom-save", () => {
    if (!frameWin || isFullscreen) return;   // 全屏期间不落盘
    const b = fbBounds();
    conf.frame = { x: b.x, y: b.y, w: b.width, h: b.height };
    saveConf();
  });

  ipcMain.on("vf-fullscreen-set", (_e, v) => setFullscreen(!!v));

  // 托管开关（面板头部按钮）：开的动作是异步的（要等 PowerShell 输入器就绪）
  ipcMain.handle("vf-takeover-set", (_e, v) => setTakeover(!!v));

  // 单步注入：换算坐标 → 调输入器 → 返回中文描述（不截图、不等待，供单步/批量共用）
  const numOf = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error("坐标 " + name + " 缺失或不是数字");
    return n;
  };
  async function runStep(s) {
    const type = String((s && s.type) || "");
    if (type === "move" || type === "click" || type === "double_click" || type === "right_click" || type === "scroll") {
      const { phys } = mapToScreen(numOf(s.x, "x"), numOf(s.y, "y"));
      let d;
      if (type === "scroll") {
        const amt = Math.min(Math.max(Math.trunc(Number(s.amount) || -3), -15), 15) || -3;
        await psCmd({ op: "scroll", x: phys.x, y: phys.y, amount: amt });
        d = "在 (" + s.x + ", " + s.y + ") " + (amt > 0 ? "向上" : "向下") + "滚了 " + Math.abs(amt) + " 格";
      } else {
        await psCmd({ op: type, x: phys.x, y: phys.y });
        d = { move: "把鼠标移到了", click: "点了", double_click: "双击了", right_click: "右键点了" }[type] + " (" + s.x + ", " + s.y + ")";
      }
      return d;
    }
    if (type === "drag") {
      const from = mapToScreen(numOf(s.x, "x"), numOf(s.y, "y"));
      const to = mapToScreen(numOf(s.x2, "x2"), numOf(s.y2, "y2"));
      await psCmd({ op: "drag", x: from.phys.x, y: from.phys.y, x2: to.phys.x, y2: to.phys.y }, 15000);
      return "从 (" + s.x + ", " + s.y + ") 拖到了 (" + s.x2 + ", " + s.y2 + ")";
    }
    if (type === "type_text") {
      const t = String(s.text == null ? "" : s.text);
      if (!t) throw new Error("type_text 需要 text");
      // 拆成 UTF-16 码元数字数组：纯 ASCII 过 stdin，绕开中文被 PowerShell 按代码页误解码的乱码坑
      const codes = [];
      for (let i = 0; i < t.length; i++) codes.push(t.charCodeAt(i));
      await psCmd({ op: "type_text", codes }, 20000);   // 长文本逐字敲，给宽一点
      const short = t.length > 24 ? t.slice(0, 24) + "…" : t;
      return "打了字：「" + short + "」";
    }
    if (type === "press_key") {
      const k = String((s.key == null ? "" : s.key)).trim();
      if (!k) throw new Error("press_key 需要 key");
      const mods = Array.isArray(s.mods) ? s.mods.map(String) : [];
      await psCmd({ op: "press_key", key: k, mods });
      return "按了键：" + (mods.length ? mods.join("+") + "+" : "") + k;
    }
    throw new Error("不认识的操作类型: " + type);
  }

  // 托管动作：一步或一串（type:"batch"+steps）→ 按序注入 → 等界面反应 → 只在最后补一张截图带回。
  // 批量是给"能预测坐标"的连续操作用的：省掉逐步来回，一轮跑完多条指令。
  ipcMain.handle("vf-action", async (_e, a) => {
    if (!takeover) return { ok: false, error: "托管没有开启（要用户在全屏模式下打开托管开关）" };
    if (actionBusy) return { ok: false, error: "上一个操作还没做完" };
    actionBusy = true;
    try {
      const finalWait = Math.min(Math.max(Number(a && a.wait_ms) || 600, 100), 10000);
      const steps = (a && a.type === "batch" && Array.isArray(a.steps)) ? a.steps : [a];
      if (!steps.length) return { ok: false, error: "没有可执行的操作" };
      if (steps.length > 12) return { ok: false, error: "一次最多 12 步（预测太长容易错位，分几轮做）" };
      const descs = [];
      for (let i = 0; i < steps.length; i++) {
        descs.push(await runStep(steps[i]));
        // 步间小停顿让界面稳一下（预测的坐标都基于同一张参考图，停顿只为机械稳定）
        if (i < steps.length - 1) {
          const gap = Math.min(Math.max(Number(steps[i] && steps[i].wait_ms) || 150, 30), 3000);
          await sleep(gap);
        }
      }
      await sleep(finalWait);
      const data = await captureInterior();
      const desc = descs.length > 1 ? ("连做了 " + descs.length + " 步：" + descs.join("；")) : descs[0];
      return { ok: true, data, desc };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      actionBusy = false;
    }
  });

  ipcMain.handle("vf-capture", async () => {
    try {
      const b64 = await captureInterior();
      return { ok: true, data: b64 };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── 录屏（纯本地：录框内画面存「视频」文件夹，不上传不惊动服务端）──
  // 渲染进程抓屏幕流自己裁自己编码，主进程只管三件事：给源+坐标、边录边落盘、收尾开文件夹。
  ipcMain.handle("vf-rec-info", async () => {
    try {
      const b = fbBounds();
      const disp = screen.getDisplayMatching(b);
      const B = frameInset;
      const interior = {
        x: b.x + B, y: b.y + TOOLBAR_H + B,
        width: b.width - B * 2, height: b.height - TOOLBAR_H - B * 2,
      };
      if (interior.width < 10 || interior.height < 10) throw new Error("框内区域太小");
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
      let src = sources.find((s) => String(s.display_id) === String(disp.id));
      if (!src && sources.length > 1) {
        const idx = screen.getAllDisplays().findIndex((d) => d.id === disp.id);
        if (idx >= 0 && idx < sources.length) src = sources[idx];
      }
      if (!src) src = sources[0];
      if (!src) throw new Error("抓不到屏幕源");
      return { ok: true, sourceId: src.id, interior, display: { bounds: disp.bounds, size: disp.size } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  let recStream2 = null, recPath = null;
  ipcMain.handle("vf-rec-file-start", () => {
    try {
      if (recStream2) { try { recStream2.destroy(); } catch (_) {} }
      const dir = path.join(app.getPath("videos"), "取景框");
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
      recPath = path.join(dir, `取景框录屏-${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.webm`);
      recStream2 = fs.createWriteStream(recPath);
      return { ok: true, path: recPath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.on("vf-rec-chunk", (_e, buf) => {
    if (recStream2) try { recStream2.write(Buffer.from(buf)); } catch (_) {}
  });
  ipcMain.handle("vf-rec-file-end", async (_e, keep) => {
    const st = recStream2, fp = recPath;
    recStream2 = null; recPath = null;
    if (!st) return { ok: false, error: "没有进行中的录制" };
    await new Promise((r) => st.end(r));
    if (keep) { shell.showItemInFolder(fp); return { ok: true, path: fp }; }
    try { fs.unlinkSync(fp); } catch (_) {}
    return { ok: true };
  });

  // 边缘闪光（快门轻提示）：两个窗口一起闪
  ipcMain.on("vf-flash", () => {
    if (frameWin) frameWin.webContents.send("vf-flash");
    if (panelWin) panelWin.webContents.send("vf-flash");
  });

  ipcMain.handle("conf-get", () => ({ server: conf.server, token: conf.token, aiName: conf.aiName, render: conf.render, hotkeyFull: conf.hotkeyFull }));
  ipcMain.handle("conf-set", (_e, { server, token, aiName, render, hotkeyFull }) => {
    if (server) conf.server = String(server).trim().replace(/\/+$/, "");
    conf.token = String(token || "").trim();
    if (aiName !== undefined) conf.aiName = String(aiName || "").trim();
    if (render) conf.render = { split: String(render.split || ""), strip: String(render.strip || "") };
    let hotkeyOk = true;
    if (hotkeyFull !== undefined) {
      conf.hotkeyFull = String(hotkeyFull || "").trim();
      hotkeyOk = registerHotkey();
    }
    saveConf();
    return { ok: true, hotkeyOk };
  });

  // 面板 → 帧窗：连接状态点同步到工具条
  ipcMain.on("vf-conn-state", (_e, state) => {
    if (frameWin) frameWin.webContents.send("vf-conn-state", state);
  });
  // 帧窗工具条按钮 → 面板执行（截图发送 / 打开设置）
  ipcMain.on("vf-panel-cmd", (_e, cmd) => {
    if (panelWin) panelWin.webContents.send("vf-panel-cmd", cmd);
  });

  ipcMain.on("vf-quit", () => {
    const b = fbBounds();
    conf.frame = { x: b.x, y: b.y, w: b.width, h: b.height };
    saveConf();
    app.quit();
  });

  createWindows();
  registerHotkey();
});

app.on("will-quit", () => { globalShortcut.unregisterAll(); stopInputHelper(); });
app.on("window-all-closed", () => app.quit());
