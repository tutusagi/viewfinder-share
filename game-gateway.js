// Stardew Valley 本地游戏网关。
// 云端只看到 game_observe / game_do 两个紧凑动作；NagiBridge 的端点和 MCP 工具目录都留在本机。
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { z } = require("zod");

const PORTS = Array.from({ length: 8 }, (_, i) => 7842 + i);
const OBSERVE_SCOPES = ["scene", "state", "nearby", "menu", "inventory", "machines", "animals", "alerts", "capabilities"];
const PRIMITIVE_ACTION_OPS = ["move", "face", "select", "use", "interact", "choose", "key", "stop"];
const ACTION_OPS = [...PRIMITIVE_ACTION_OPS, "sequence"];
const MAX_SEQUENCE_STEPS = 64;
const SAFE_KEYS = ["confirm", "action", "ok", "menu", "cancel", "back", "skip"];
const SAFE_BUTTONS = ["ok", "cancel", "back", "forward", "close"];
const DIRS = { up: 0, right: 1, down: 2, left: 3 };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanConfig(raw) {
  const p = Number(raw && raw.port);
  return {
    port: Number.isInteger(p) && p >= 7842 && p <= 7849 ? p : 0,
    player: String((raw && raw.player) || "").trim().slice(0, 80),
  };
}

function asInt(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} 必须是整数`);
  return n;
}

// 云端工具 schema 故意保持极简以节省每轮上下文，模型偶尔会把 JSON 数字写成字符串。
// 只接纳纯整数字符串；"12px"、空串等仍交给 Zod 拒绝，不能做宽松的隐式猜测。
function integerArg(min, max) {
  let schema = z.number().int();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return /^-?\d+$/.test(trimmed) ? Number(trimmed) : value;
  }, schema);
}

function sequenceArg() {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed.startsWith("[")) return value;
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : value;
    } catch (_) {
      return value;
    }
  }, z.array(sequenceStepSchema).min(1).max(MAX_SEQUENCE_STEPS));
}

const sequenceStepSchema = z.object({
  op: z.enum(PRIMITIVE_ACTION_OPS),
  x: integerArg().optional(),
  y: integerArg().optional(),
  name: z.string().max(80).optional(),
  direction: z.union([integerArg(0, 3), z.enum(["up", "right", "down", "left"])]).optional(),
  option: integerArg(0, 50).optional(),
  button: z.enum(SAFE_BUTTONS).optional(),
  key: z.enum(SAFE_KEYS).optional(),
  wait_ms: integerArg(0, 2000).optional(),
}).strict();

function compact(value, depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > 500 ? value.slice(0, 500) + "…" : value;
  if (depth >= 5) return "[…]";
  if (Array.isArray(value)) {
    const out = value.slice(0, 120).map((v) => compact(v, depth + 1));
    if (value.length > out.length) out.push({ truncated: value.length - out.length });
    return out;
  }
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 80)) out[k] = compact(v, depth + 1);
    return out;
  }
  return String(value);
}

function summarizeState(raw, includeInventory = false) {
  if (!raw || !raw.worldReady) return { worldReady: false };
  const p = raw.player || {};
  const loc = raw.location || {};
  const t = raw.time || {};
  const out = {
    worldReady: true,
    player: {
      name: p.name,
      position: [p.x, p.y],
      health: [p.health, p.maxHealth],
      stamina: [Math.round(Number(p.stamina) || 0), Math.round(Number(p.maxStamina) || 0)],
      money: p.money,
      held: p.currentTool || null,
      facing: p.facingDirection,
      moving: !!p.isMoving,
    },
    location: { name: loc.name, size: [loc.mapWidth, loc.mapHeight] },
    time: { clock: t.timeOfDay, day: t.dayOfMonth, season: t.season, year: t.year },
    menu: raw.activeMenu || null,
    event: raw.activeEvent || null,
    npcs: Array.isArray(raw.npcs) ? raw.npcs.slice(0, 30) : [],
  };
  if (includeInventory) out.inventory = compact(raw.inventory || []);
  return out;
}

function summarizeNearby(raw) {
  const all = Array.isArray(raw && raw.tiles) ? raw.tiles : [];
  // NagiBridge 会把每个可挖地块也列出来；只保留真正有内容/阻挡的格子，避免把地图塞进模型上下文。
  const useful = all.filter((tile) => tile && (
    tile.object || tile.terrain || tile.resource || tile.crop || tile.passable === false
  ));
  const center = raw && raw.center ? raw.center : { x: 0, y: 0 };
  useful.sort((a, b) => {
    const ad = Math.abs((a.x || 0) - center.x) + Math.abs((a.y || 0) - center.y);
    const bd = Math.abs((b.x || 0) - center.x) + Math.abs((b.y || 0) - center.y);
    return ad - bd;
  });
  return {
    location: raw && raw.location,
    center,
    radius: raw && raw.radius,
    tiles: compact(useful.slice(0, 120)),
    truncatedTiles: Math.max(0, useful.length - 120),
    npcs: compact((raw && raw.npcs) || []),
    monsters: compact((raw && raw.monsters) || []),
    farmers: compact((raw && raw.farmers) || []),
  };
}

class GameGateway {
  constructor(options = {}) {
    this.fetch = options.fetchFn || global.fetch;
    if (typeof this.fetch !== "function") throw new Error("当前运行环境不支持 fetch");
    this.config = cleanConfig(options.config);
    this.discoveryTimeoutMs = options.discoveryTimeoutMs || 700;
    this.requestTimeoutMs = options.requestTimeoutMs || 8000;
    this.movementPollMs = options.movementPollMs || 140;
    this.movementMismatchGraceMs = options.movementMismatchGraceMs || 700;
    this.sequenceTimeoutMs = options.sequenceTimeoutMs || 150000;
    this.onAudit = typeof options.onAudit === "function" ? options.onAudit : () => {};
    this.enabled = false;
    this.target = null;
    this.available = [];
    this.client = null;
    this.server = null;
    this._initializing = null;
  }

  configure(raw) {
    const next = cleanConfig(raw);
    const changed = next.port !== this.config.port || next.player !== this.config.player;
    this.config = next;
    if (changed) this.target = null;
    return { ...this.config };
  }

  async _fetchJson(port, endpoint, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this.requestTimeoutMs);
    // NagiBridge 的 Windows HttpListener 前缀是 http://localhost:<port>/；用 127.0.0.1 会被 HTTP.sys
    // 以 Invalid Hostname 拒绝。这里仍固定为本机主机名，不接受云端传入 URL。
    const url = `http://localhost:${port}${endpoint}`;
    try {
      const init = {
        method: options.method || "GET",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      };
      if (options.body !== undefined) init.body = JSON.stringify(options.body);
      const res = await this.fetch(url, init);
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; }
      catch (_) { throw new Error(`NagiBridge 返回了非 JSON：${text.slice(0, 120)}`); }
      if (!res.ok) throw new Error(data.error || `NagiBridge HTTP ${res.status}`);
      if (data && data.ok === false) throw new Error(data.error || "NagiBridge 操作失败");
      return data;
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error(`连接 NagiBridge 超时（${port}）`);
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  async _probe(port) {
    try {
      const status = await this._fetchJson(port, "/status", { timeoutMs: this.discoveryTimeoutMs });
      if (status.server !== "NagiBridge") return null;
      let state = null;
      if (status.worldReady) {
        try { state = await this._fetchJson(port, "/state", { timeoutMs: this.discoveryTimeoutMs + 500 }); }
        catch (_) {}
      }
      return {
        port,
        worldReady: !!status.worldReady,
        multiplayer: !!status.isMultiplayer,
        player: state && state.player ? state.player.name : "",
        location: state && state.location ? state.location.name : "",
      };
    } catch (_) {
      return null;
    }
  }

  async discover() {
    const ports = this.config.port ? [this.config.port] : PORTS;
    const found = (await Promise.all(ports.map((port) => this._probe(port)))).filter(Boolean);
    this.available = found;
    const wanted = this.config.player.toLocaleLowerCase();
    this.target = (wanted && found.find((x) => String(x.player).toLocaleLowerCase() === wanted))
      || (this.target && found.find((x) => x.port === this.target.port))
      || found.find((x) => x.worldReady)
      || found[0]
      || null;
    return { target: this.target, available: this.available };
  }

  async setEnabled(value) {
    value = !!value;
    if (!value) {
      if (this.target) {
        try { await this._fetchJson(this.target.port, "/stop", { method: "POST", body: {}, timeoutMs: 1500 }); }
        catch (_) {}
      }
      this.enabled = false;
      return this.status();
    }
    await this.discover();
    if (!this.target) throw new Error("没有发现 NagiBridge。请先用 SMAPI 进入存档，再打开游戏托管");
    if (!this.target.worldReady) throw new Error(`发现了 NagiBridge（${this.target.port}），但游戏存档还没载入`);
    await this._initMcp();
    this.enabled = true;
    return this.status();
  }

  status() {
    return {
      enabled: this.enabled,
      connected: !!this.target,
      target: this.target,
      available: this.available,
      config: { ...this.config },
    };
  }

  async _initMcp() {
    if (this.client) return;
    if (this._initializing) return this._initializing;
    this._initializing = (async () => {
      const server = new McpServer({ name: "viewfinder-stardew-gateway", version: "1.0.0" });
      server.registerTool("game_observe", {
        title: "观察星露谷",
        description: "读取当前游戏所需的一个小范围状态。",
        inputSchema: {
          scope: z.enum(OBSERVE_SCOPES).default("state"),
          radius: integerArg(1, 20).optional(),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      }, async (args) => this._mcpResult(await this._observe(args)));

      server.registerTool("game_do", {
        title: "操作星露谷",
        description: "执行一个动作，或执行模型明确列出的连续基础动作；不允许作弊、任意端点或系统命令。",
        inputSchema: {
          op: z.enum(ACTION_OPS),
          x: integerArg().optional(),
          y: integerArg().optional(),
          name: z.string().max(80).optional(),
          direction: z.union([integerArg(0, 3), z.enum(["up", "right", "down", "left"])]).optional(),
          option: integerArg(0, 50).optional(),
          button: z.enum(SAFE_BUTTONS).optional(),
          key: z.enum(SAFE_KEYS).optional(),
          steps: sequenceArg().optional(),
        },
        annotations: { destructiveHint: false, openWorldHint: false },
      }, async (args) => this._mcpResult(await this._act(args)));

      const client = new Client({ name: "viewfinder", version: "1.0.0" }, { capabilities: {} });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      this.server = server;
      this.client = client;
    })();
    try { await this._initializing; }
    finally { this._initializing = null; }
  }

  _mcpResult(data) {
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }

  async _request(endpoint, options) {
    if (!this.target) await this.discover();
    if (!this.target) throw new Error("NagiBridge 未连接");
    try {
      return await this._fetchJson(this.target.port, endpoint, options);
    } catch (e) {
      // 游戏重启后端口可能变化；只对读取请求自动重新发现，写操作不盲目重试以免重复执行。
      if (!options || !options.method || options.method === "GET") this.target = null;
      throw e;
    }
  }

  async _observe(args) {
    const scope = args.scope || "state";
    if (scope === "capabilities") {
      return { scopes: OBSERVE_SCOPES.filter((x) => x !== "capabilities"), actions: ACTION_OPS, target: this.target };
    }
    if (scope === "state" || scope === "inventory") {
      return summarizeState(await this._request("/state"), scope === "inventory");
    }
    if (scope === "scene") {
      const radius = Math.max(1, Math.min(20, Number(args.radius) || 8));
      const [state, nearby] = await Promise.all([
        this._request("/state"),
        this._request(`/surroundings?radius=${radius}`),
      ]);
      return { state: summarizeState(state), nearby: summarizeNearby(nearby) };
    }
    if (scope === "nearby") {
      const radius = Math.max(1, Math.min(20, Number(args.radius) || 8));
      return summarizeNearby(await this._request(`/surroundings?radius=${radius}`));
    }
    const endpoints = { menu: "/menu", machines: "/machines", animals: "/animals", alerts: "/alerts?peek=true" };
    return compact(await this._request(endpoints[scope]));
  }

  async _waitForMovement(targetX, targetY, timeoutMs = 12000) {
    const started = Date.now();
    let state, mismatchSince = 0;
    do {
      await wait(this.movementPollMs);
      state = await this._request("/state");
      const p = state.player;
      if (p && !p.isMoving && p.x === targetX && p.y === targetY) return { settled: true, state };
      if (p && !p.isMoving) {
        if (!mismatchSince) mismatchSince = Date.now();
        // NagiBridge 偶尔会先清掉 isMoving，下一两个游戏帧才刷新 TilePoint；给它一个短宽限期。
        if (Date.now() - mismatchSince >= this.movementMismatchGraceMs) {
          return { settled: false, state, reason: `stopped_at_${p.x}_${p.y}` };
        }
      } else {
        mismatchSince = 0;
      }
    } while (Date.now() - started < timeoutMs);
    return { settled: false, state, reason: "timeout" };
  }

  async _act(args) {
    const op = args.op;
    if (op === "sequence") return this._actSequence(args.steps || []);
    let result;
    if (op === "move") {
      const x = asInt(args.x, "x"), y = asInt(args.y, "y");
      const before = await this._request("/state");
      const startX = before && before.player ? before.player.x : x;
      // NagiBridge 1.0.0 用 Farmer.Position 对齐格子中心；向左寻路会在目标右边一格提前结束。
      // 只在向左时把桥接层目标多偏一格，对模型仍保持真实目标坐标。
      const bridgeX = x < startX ? Math.max(0, x - 1) : x;
      result = await this._request("/move", { method: "POST", body: { x: bridgeX, y } });
      const movement = await this._waitForMovement(x, y);
      const finalPos = movement.state && movement.state.player
        ? `(${movement.state.player.x}, ${movement.state.player.y})`
        : "未知位置";
      return {
        action: op,
        result: { accepted: true, requested: [x, y], bridgeTarget: [bridgeX, y] },
        settled: movement.settled,
        state: summarizeState(movement.state),
        desc: movement.settled ? `走到了 (${x}, ${y})` : `没到达 (${x}, ${y})，停在 ${finalPos}`,
      };
    }
    if (op === "face") {
      const direction = typeof args.direction === "string" ? DIRS[args.direction] : asInt(args.direction, "direction");
      result = await this._request("/face", { method: "POST", body: { direction } });
    } else if (op === "select") {
      if (!args.name) throw new Error("select 需要 name");
      result = await this._request("/select", { method: "POST", body: { name: args.name } });
    } else if (op === "use") {
      if (args.name) await this._request("/select", { method: "POST", body: { name: args.name } });
      result = await this._request("/use", { method: "POST", body: { force: false } });
      await wait(220);
    } else if (op === "interact") {
      result = await this._request("/interact", { method: "POST", body: {} });
      await wait(160);
    } else if (op === "choose") {
      if (args.option === undefined && !args.button) throw new Error("choose 需要 option 或 button");
      result = await this._request("/menu/click", {
        method: "POST",
        body: args.option !== undefined ? { option: args.option } : { button: args.button },
      });
      await wait(160);
    } else if (op === "key") {
      if (!SAFE_KEYS.includes(args.key)) throw new Error("不允许这个按键");
      result = await this._request("/key", { method: "POST", body: { key: args.key, count: 1 } });
      await wait(160);
    } else if (op === "stop") {
      result = await this._request("/stop", { method: "POST", body: {} });
    } else {
      throw new Error(`不允许的游戏操作：${op}`);
    }

    const state = summarizeState(await this._request("/state"));
    const facingName = typeof args.direction === "string"
      ? args.direction
      : ["up", "right", "down", "left"][args.direction];
    const descs = {
      face: `朝向已设为 ${facingName}；只保留最后一次朝向，不是旋转动画`,
      select: `选择了 ${args.name}`, use: `使用了${args.name ? " " + args.name : "当前物品"}`,
      interact: "与面前目标互动了", choose: "选择了菜单项", key: `按了游戏键 ${args.key}`, stop: "停止了移动",
    };
    return { action: op, result: compact(result), state, desc: descs[op] || `执行了 ${op}` };
  }

  async _actSequence(steps) {
    if (!Array.isArray(steps) || !steps.length) throw new Error("sequence 需要非空 steps");
    const started = Date.now();
    const executed = [];
    let lastState = null;
    let stoppedAt = null;
    let error = "";

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!this.enabled) {
        stoppedAt = i; error = "游戏托管已被关闭"; break;
      }
      if (Date.now() - started >= this.sequenceTimeoutMs) {
        stoppedAt = i; error = "连续操作达到时间上限"; break;
      }
      try {
        const outcome = await this._act(step);
        lastState = outcome.state || lastState;
        executed.push({
          index: i,
          op: step.op,
          ok: true,
          settled: outcome.settled,
          position: outcome.state && outcome.state.player ? outcome.state.player.position : undefined,
          result: compact(outcome.result),
          desc: outcome.desc,
        });
        if (outcome.settled === false) {
          stoppedAt = i; error = outcome.desc || "移动没有到达目标"; break;
        }
        if (step.wait_ms) await wait(step.wait_ms);
      } catch (e) {
        // 前面的动作可能已经真实发生，绝不能把整串抛成可重试错误；返回断点让模型重新观察。
        stoppedAt = i;
        error = e.message;
        executed.push({ index: i, op: step.op, ok: false, error: e.message });
        break;
      }
    }

    const complete = stoppedAt === null;
    if (!lastState) {
      try { lastState = summarizeState(await this._request("/state")); } catch (_) {}
    }
    return {
      action: "sequence",
      complete,
      completed: executed.filter((x) => x.ok).length,
      total: steps.length,
      stoppedAt,
      error: error || undefined,
      steps: executed,
      state: lastState,
      desc: complete
        ? `连续完成了 ${executed.length} 个实际游戏动作`
        : `完成 ${executed.filter((x) => x.ok).length}/${steps.length} 步后停止：${error}`,
    };
  }

  async call(tool, args = {}) {
    if (!this.enabled) throw new Error("游戏托管没有开启");
    if (!['game_observe', 'game_do'].includes(tool)) throw new Error(`不允许的 MCP 工具：${tool}`);
    await this._initMcp();
    const started = Date.now();
    try {
      const response = await this.client.callTool({ name: tool, arguments: args });
      const text = response.content && response.content.find((x) => x.type === "text");
      const raw = text && typeof text.text === "string" ? text.text : "";
      if (response.isError) throw new Error(raw || "本地 MCP 工具执行失败");
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; }
      catch (_) { throw new Error(`本地 MCP 返回了非 JSON：${raw.slice(0, 160)}`); }
      this.onAudit({ at: new Date().toISOString(), tool, args, ok: true, ms: Date.now() - started, result: data });
      return data;
    } catch (e) {
      this.onAudit({ at: new Date().toISOString(), tool, args, ok: false, ms: Date.now() - started, error: e.message });
      throw e;
    }
  }

  async close() {
    this.enabled = false;
    try { if (this.client) await this.client.close(); } catch (_) {}
    try { if (this.server) await this.server.close(); } catch (_) {}
    this.client = null;
    this.server = null;
  }
}

module.exports = {
  GameGateway,
  ACTION_OPS,
  OBSERVE_SCOPES,
  summarizeState,
  summarizeNearby,
};
