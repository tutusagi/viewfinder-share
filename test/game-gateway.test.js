const test = require("node:test");
const assert = require("node:assert/strict");
const { ACTION_OPS, GameGateway, summarizeNearby, summarizeState } = require("../game-gateway");

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function state(name, x = 10, y = 20, moving = false) {
  return {
    ok: true,
    worldReady: true,
    player: {
      name, x, y, health: 100, maxHealth: 100, stamina: 250, maxStamina: 270,
      money: 500, currentTool: "Axe", facingDirection: 2, isMoving: moving,
    },
    location: { name: "Farm", mapWidth: 80, mapHeight: 65 },
    time: { timeOfDay: 610, dayOfMonth: 1, season: "spring", year: 1 },
    activeMenu: null,
    activeEvent: null,
    npcs: [],
    inventory: [{ name: "Axe", stack: 1, category: "Tool" }],
  };
}

test("状态摘要默认不把完整背包带进上下文", () => {
  const raw = state("AI玩家");
  assert.equal(summarizeState(raw).inventory, undefined);
  assert.equal(summarizeState(raw, true).inventory[0].name, "Axe");
});

test("附近摘要会去掉只有 diggable 的普通地块", () => {
  const result = summarizeNearby({
    center: { x: 10, y: 10 }, radius: 8, location: "Farm",
    tiles: [
      { x: 10, y: 11, passable: true, diggable: true },
      { x: 11, y: 10, passable: true, terrain: "HoeDirt", crop: "24" },
      { x: 12, y: 10, passable: false },
    ],
    npcs: [], monsters: [], farmers: [],
  });
  assert.equal(result.tiles.length, 2);
  assert.equal(result.tiles.some((x) => x.x === 10 && x.y === 11), false);
});

test("动作面不暴露一键改变多格世界状态的宏", () => {
  for (const op of ["harvest", "clear", "water_all", "ripen"])
    assert.equal(ACTION_OPS.includes(op), false, `${op} 不应暴露给模型`);
});

test("自动发现端口并按玩家名选择真实 Farmhand", async () => {
  const fetchFn = async (rawUrl) => {
    const url = new URL(rawUrl);
    const port = Number(url.port);
    if (port !== 7842 && port !== 7843) throw new Error("connection refused");
    if (url.pathname === "/status") return response({
      server: "NagiBridge", version: "1.0.0", port, worldReady: true, isMultiplayer: true,
    });
    if (url.pathname === "/state") return response(state(port === 7842 ? "主机玩家" : "AI玩家"));
    if (url.pathname === "/stop") return response({ ok: true });
    throw new Error("unexpected request " + rawUrl);
  };
  const gateway = new GameGateway({
    fetchFn, config: { port: 0, player: "AI玩家" }, discoveryTimeoutMs: 30,
  });
  try {
    const status = await gateway.setEnabled(true);
    assert.equal(status.target.port, 7843);
    assert.equal(status.target.player, "AI玩家");
    const observed = await gateway.call("game_observe", { scope: "state" });
    assert.equal(observed.player.name, "AI玩家");
  } finally {
    await gateway.setEnabled(false);
    await gateway.close();
  }
});

test("game_do move 通过 MCP 调用 /move 并等待角色停下", async () => {
  let stateReads = 0;
  const requests = [];
  const fetchFn = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    requests.push({ path: url.pathname, method: init.method, body: init.body && JSON.parse(init.body) });
    if (url.pathname === "/status") return response({
      server: "NagiBridge", version: "1.0.0", port: 7842, worldReady: true, isMultiplayer: false,
    });
    if (url.pathname === "/state") {
      stateReads++;
      if (stateReads === 1) return response(state("AI玩家", 10, 20, false)); // discovery
      if (stateReads === 2) return response(state("AI玩家", 11, 20, true));
      return response(state("AI玩家", 12, 20, false));
    }
    if (url.pathname === "/move") return response({ ok: true, pathStarted: true, steps: 2 });
    if (url.pathname === "/stop") return response({ ok: true });
    throw new Error("unexpected request " + rawUrl);
  };
  const gateway = new GameGateway({
    fetchFn, config: { port: 7842 }, discoveryTimeoutMs: 30, movementPollMs: 1,
  });
  try {
    await gateway.setEnabled(true);
    // 云端轻量 schema 下模型可能把数字写成字符串；本地边界应严格、可预测地转成整数。
    const result = await gateway.call("game_do", { op: "move", x: "12", y: "20" });
    assert.equal(result.settled, true);
    assert.deepEqual(result.state.player.position, [12, 20]);
    assert.deepEqual(requests.find((x) => x.path === "/move").body, { x: 12, y: 20 });
  } finally {
    await gateway.setEnabled(false);
    await gateway.close();
  }
});

test("nearby 接受模型传来的数字字符串 radius", async () => {
  let surroundingsUrl;
  const fetchFn = async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname === "/status") return response({
      server: "NagiBridge", port: 7842, worldReady: true, isMultiplayer: false,
    });
    if (url.pathname === "/state") return response(state("AI玩家"));
    if (url.pathname === "/surroundings") {
      surroundingsUrl = url;
      return response({ location: "Farm", center: { x: 10, y: 20 }, radius: 8, tiles: [] });
    }
    if (url.pathname === "/stop") return response({ ok: true });
    throw new Error("unexpected request " + rawUrl);
  };
  const gateway = new GameGateway({ fetchFn, config: { port: 7842 } });
  try {
    await gateway.setEnabled(true);
    const result = await gateway.call("game_observe", { scope: "nearby", radius: "8" });
    assert.equal(result.radius, 8);
    assert.equal(surroundingsUrl.searchParams.get("radius"), "8");
  } finally {
    await gateway.setEnabled(false);
    await gateway.close();
  }
});

test("scene 一次返回规划所需的状态与附近格子", async () => {
  const fetchFn = async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname === "/status") return response({
      server: "NagiBridge", port: 7842, worldReady: true, isMultiplayer: false,
    });
    if (url.pathname === "/state") return response(state("AI玩家", 10, 20));
    if (url.pathname === "/surroundings") return response({
      location: "Farm", center: { x: 10, y: 20 }, radius: 8,
      tiles: [{ x: 11, y: 20, terrain: "HoeDirt", crop: "24", harvestable: true }],
    });
    if (url.pathname === "/stop") return response({ ok: true });
    throw new Error("unexpected request " + rawUrl);
  };
  const gateway = new GameGateway({ fetchFn, config: { port: 7842 } });
  try {
    await gateway.setEnabled(true);
    const result = await gateway.call("game_observe", { scope: "scene", radius: "8" });
    assert.deepEqual(result.state.player.position, [10, 20]);
    assert.equal(result.nearby.tiles[0].harvestable, true);
  } finally {
    await gateway.setEnabled(false);
    await gateway.close();
  }
});

test("sequence 在一次 MCP 调用中按模型给定顺序执行真实基础动作", async () => {
  let stateReads = 0;
  const writes = [];
  const fetchFn = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    if (url.pathname === "/status") return response({
      server: "NagiBridge", port: 7842, worldReady: true, isMultiplayer: false,
    });
    if (url.pathname === "/state") {
      stateReads++;
      return response(state("AI玩家", stateReads >= 4 ? 11 : 10, 20, false));
    }
    if (["/select", "/move", "/face", "/interact"].includes(url.pathname)) {
      writes.push({ path: url.pathname, body: init.body && JSON.parse(init.body) });
      return response(url.pathname === "/interact" ? { ok: true, actionTriggered: true } : { ok: true });
    }
    if (url.pathname === "/stop") return response({ ok: true });
    throw new Error("unexpected request " + rawUrl);
  };
  const gateway = new GameGateway({
    fetchFn, config: { port: 7842 }, movementPollMs: 1, movementMismatchGraceMs: 10,
  });
  try {
    await gateway.setEnabled(true);
    const result = await gateway.call("game_do", {
      op: "sequence",
      steps: [
        { op: "select", name: "Axe" },
        { op: "move", x: "11", y: "20" },
        { op: "face", direction: "right" },
        { op: "interact" },
      ],
    });
    assert.equal(result.complete, true);
    assert.equal(result.completed, 4);
    assert.deepEqual(writes.map((x) => x.path), ["/select", "/move", "/face", "/interact"]);
    assert.deepEqual(result.state.player.position, [11, 20]);
  } finally {
    await gateway.setEnabled(false);
    await gateway.close();
  }
});

test("sequence 兼容被外层 MCP 序列化成 JSON 字符串的 steps", async () => {
  const writes = [];
  const fetchFn = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    if (url.pathname === "/status") return response({
      server: "NagiBridge", port: 7842, worldReady: true, isMultiplayer: false,
    });
    if (url.pathname === "/state") return response(state("AI玩家"));
    if (["/face", "/interact"].includes(url.pathname)) {
      writes.push({ path: url.pathname, body: init.body && JSON.parse(init.body) });
      return response(url.pathname === "/interact" ? { ok: true, actionTriggered: true } : { ok: true });
    }
    if (url.pathname === "/stop") return response({ ok: true });
    throw new Error("unexpected request " + rawUrl);
  };
  const gateway = new GameGateway({ fetchFn, config: { port: 7842 } });
  try {
    await gateway.setEnabled(true);
    const result = await gateway.call("game_do", {
      op: "sequence",
      steps: JSON.stringify([{ op: "face", direction: "right" }, { op: "interact" }]),
    });
    assert.equal(result.complete, true);
    assert.equal(result.completed, 2);
    assert.deepEqual(writes.map((x) => x.path), ["/face", "/interact"]);
  } finally {
    await gateway.setEnabled(false);
    await gateway.close();
  }
});

test("sequence 中途失败会返回断点而不是诱导整串重试", async () => {
  const fetchFn = async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname === "/status") return response({
      server: "NagiBridge", port: 7842, worldReady: true, isMultiplayer: false,
    });
    if (url.pathname === "/state") return response(state("AI玩家"));
    if (url.pathname === "/face") return response({ ok: true, direction: 2 });
    if (url.pathname === "/stop") return response({ ok: true });
    throw new Error("unexpected request " + rawUrl);
  };
  const gateway = new GameGateway({ fetchFn, config: { port: 7842 } });
  try {
    await gateway.setEnabled(true);
    const result = await gateway.call("game_do", {
      op: "sequence",
      steps: [{ op: "face", direction: "down" }, { op: "select" }, { op: "interact" }],
    });
    assert.equal(result.complete, false);
    assert.equal(result.completed, 1);
    assert.equal(result.stoppedAt, 1);
    assert.match(result.error, /select 需要 name/);
  } finally {
    await gateway.setEnabled(false);
    await gateway.close();
  }
});

test("移动状态提前变 false 时仍等待坐标真正到达", async () => {
  let stateReads = 0;
  let moveBody;
  const fetchFn = async (rawUrl, init) => {
    const url = new URL(rawUrl);
    if (url.pathname === "/status") return response({
      server: "NagiBridge", port: 7842, worldReady: true, isMultiplayer: false,
    });
    if (url.pathname === "/state") {
      stateReads++;
      if (stateReads <= 3) return response(state("AI玩家", 64, 20, false)); // discovery + action preflight + 短暂旧坐标
      return response(state("AI玩家", 63, 20, false));
    }
    if (url.pathname === "/move") {
      moveBody = JSON.parse(init.body);
      return response({ ok: true, pathStarted: true, steps: 2 });
    }
    if (url.pathname === "/stop") return response({ ok: true });
    throw new Error("unexpected request " + rawUrl);
  };
  const gateway = new GameGateway({
    fetchFn, config: { port: 7842 }, discoveryTimeoutMs: 30,
    movementPollMs: 1, movementMismatchGraceMs: 20,
  });
  try {
    await gateway.setEnabled(true);
    const result = await gateway.call("game_do", { op: "move", x: 63, y: 20 });
    assert.equal(result.settled, true);
    assert.deepEqual(result.state.player.position, [63, 20]);
    assert.deepEqual(moveBody, { x: 62, y: 20 });
  } finally {
    await gateway.setEnabled(false);
    await gateway.close();
  }
});

test("未开启游戏托管时拒绝 MCP 调用", async () => {
  const gateway = new GameGateway({ fetchFn: async () => response({}) });
  await assert.rejects(() => gateway.call("game_observe", { scope: "state" }), /没有开启/);
});

test("MCP 工具参数错误不会被当成成功结果", async () => {
  const fetchFn = async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname === "/status") return response({
      server: "NagiBridge", port: 7842, worldReady: true, isMultiplayer: false,
    });
    if (url.pathname === "/state") return response(state("AI玩家"));
    if (url.pathname === "/stop") return response({ ok: true });
    throw new Error("unexpected request " + rawUrl);
  };
  const gateway = new GameGateway({ fetchFn, config: { port: 7842 } });
  try {
    await gateway.setEnabled(true);
    await assert.rejects(
      () => gateway.call("game_do", { op: "select" }),
      (error) => /select 需要 name/.test(error.message) && !/Unexpected token/.test(error.message),
    );
  } finally {
    await gateway.setEnabled(false);
    await gateway.close();
  }
});
