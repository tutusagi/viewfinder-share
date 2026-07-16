#!/usr/bin/env node
// viewfinder MCP（stdio）：让 AI 看用户的电脑屏幕。
// 实体是用户桌面上的一个"取景框"——置顶小框，拖到哪、AI 就只能看到哪。
// 框就是用户给的许可范围：App 关着就什么都看不到。
// peek_screen 看完即焚 / capture_screen 正式留档 / control_screen 托管操作鼠标键盘。
// 本进程只是翻译层：把工具调用转成对服务端两个 localhost 内部端点的 HTTP 请求（见 PROTOCOL.md 第 6 节）。
//
// 工具定义极简：说明文字和参数表全在 SKILL.md 里，这里只留名字和指针——
// 省每个 session 的常驻上下文，细节用到时再展开。schema 不做校验用，参数名靠 skill 教。
const http = require('http');

const API = process.env.VIEWFINDER_API || 'http://127.0.0.1:3100';

const SEE_SKILL = '用法和参数见 viewfinder skill，用前先读。';
const TOOLS = [
  { name: 'peek_screen', description: SEE_SKILL, inputSchema: { type: 'object' } },
  { name: 'capture_screen', description: SEE_SKILL, inputSchema: { type: 'object' } },
  { name: 'control_screen', description: SEE_SKILL, inputSchema: { type: 'object' } },
];

function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

function post(apiPath, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(API + apiPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: timeoutMs || 25000,
    }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('响应解析失败: ' + data.slice(0, 100))); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('等待超时')); });
    req.on('error', reject);
    req.end(body);
  });
}

async function doCapture(mode) {
  const r = await post('/api/internal/vf-capture', { mode });
  if (!r.ok) {
    if (r.error === 'offline') return '（取景框现在没开——用户不在电脑前，或者还没打开取景框 App。）';
    return '（没截到…' + (r.error || '未知原因') + '）';
  }
  return mode === 'temp'
    ? `（咔嚓，取景框闪了一下光。画面存在 ${r.path} ——用 Read 看，这是临时图，看完即焚。）`
    : `（咔嚓，取景框闪了一下光。这张会留档：${r.path} ——用 Read 看。）`;
}

// 托管返回富内容（文字 + 内联图片）：操作后的画面直接夹在工具结果里，
// AI 当场看到操作后果，不用再单独 Read，可以立刻接着下一步。
function textBlock(t) { return { content: [{ type: 'text', text: t }] }; }

async function doAction(args) {
  const a = args || {};
  let action;
  if (Array.isArray(a.steps) && a.steps.length) {
    // 批量：一串预测好的动作，一次跑完只回一张图
    action = {
      type: 'batch', wait_ms: a.wait_ms,
      steps: a.steps.map((s) => ({
        type: s.type, x: s.x, y: s.y, x2: s.x2, y2: s.y2, amount: s.amount,
        text: s.text, key: s.key, mods: s.mods, wait_ms: s.wait_ms,
      })),
    };
  } else {
    action = {
      type: a.action, x: a.x, y: a.y, x2: a.x2, y2: a.y2, amount: a.amount,
      text: a.text, key: a.key, mods: a.mods, wait_ms: a.wait_ms,
    };
  }
  const r = await post('/api/internal/vf-action', { action }, 65000);
  if (!r.ok) {
    if (r.error === 'offline') return textBlock('（取景框现在没开——用户不在电脑前。）');
    return textBlock('（操作没成功…' + (r.error || '未知原因') + '）');
  }
  const note = `（${r.desc || '操作完成'}。下面这张就是操作之后的画面——看着它接着操作就好。` +
    '如果界面还没反应过来、画面没变，把下次操作的 wait_ms 调大些，或先用 peek_screen 再看一眼。）';
  const content = [{ type: 'text', text: note }];
  if (r.data) content.push({ type: 'image', data: r.data, mimeType: 'image/jpeg' });
  return { content };
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch (e) { continue; }
    handle(m);
  }
});

function handle(m) {
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'viewfinder', version: '1.0' } } });
  } else if (m.method === 'notifications/initialized') {
    // no-op
  } else if (m.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
  } else if (m.method === 'tools/call') {
    const name = m.params && m.params.name;
    const reply = (text) => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } });
    const fail = (e) => send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '（唔，没看成…' + e.message + '）' }], isError: true } });
    if (name === 'peek_screen') {
      doCapture('temp').then(reply).catch(fail);
    } else if (name === 'capture_screen') {
      doCapture('keep').then(reply).catch(fail);
    } else if (name === 'control_screen') {
      doAction(m.params && m.params.arguments)
        .then((result) => send({ jsonrpc: '2.0', id: m.id, result }))
        .catch(fail);
    } else {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown tool: ' + name } });
    }
  } else if (m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } });
  }
}
