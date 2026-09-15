// citrine-devtools bridge.js 契约测试（node:test，无第三方依赖）
//
// 覆盖 PROTOCOL.md §桥接脚本行为契约 + 指令表：
//   激活条件（SSR/生产零影响）/ 中继地址覆盖 / hello 幂等 / 100ms 采集 +
//   条目指纹去重（ring 滚动安全）/ 50ms 聚合窗口 / 上报故障静默降级（warn 一次）/
//   set_signal·force_rerun·request_tree·request_graph·highlight_node /
//   未知 type 与畸形消息忽略 / cmd 异常回 error / 热更新重求值防重
//
// 运行：node --test   （或 npm test）
// Opal 以遵守 $方法 调用惯例的 mock 呈现（与 Opal 1.x 运行时的 JS 形态一致：
// 模块方法 $debug_write_log()、Ring#$to_a() → Array#$to_n()、$object_id()、
// $const_get("VERSION")、Opal.nil、Opal.hash）。
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BRIDGE_SOURCE = readFileSync(
  path.join(fileURLToPath(new URL(".", import.meta.url)), "../lib/citrine-devtools/bridge.js"),
  "utf8"
);

// ── 测试夹具：vm 沙箱 + 可控定时器 + EventSource/fetch mock + Opal mock ──

// Ruby Hash 的 mock：$to_n 返回纯 JS 副本（对应 Opal Hash#to_n）
function rbHash(obj) {
  return { $to_n: () => JSON.parse(JSON.stringify(obj)) };
}

// Ring 的 mock：$to_a 返回新数组，数组带 $to_n 逐元素转换（对应 Opal Array#to_n）
function rbRing(items) {
  return {
    $to_a() {
      const arr = items.slice();
      arr.$to_n = () => arr.map((x) => (x && typeof x.$to_n === "function" ? x.$to_n() : x));
      return arr;
    }
  };
}

function makeHarness(options = {}) {
  const opts = {
    citrineDev: true,
    opal: true,
    relayUrl: undefined,
    documentTitle: undefined, // document.title → hello.app_name
    devtoolsRoot: undefined, // window.CITRINE_DEVTOOLS_ROOT（Node 或组件实例）
    rings: { write: [], flush: [], event: [] },
    signals: [], // [{ id, setCalls: [], throwOnSet }]
    effects: [], // [{ id, runCalls }]
    // null | { rootNodeMethod: bool, root: node, ivarRoot: node }
    renderer: null,
    graph: { signals: [], effects: [] },
    tree: { node_id: 9, component: "Shell", props: {}, state: {}, computed: {}, children: [] },
    fetchImpl: undefined,
    ...options
  };

  const records = {
    intervals: [], // [{ fn, ms }]
    timeouts: [], // [{ fn, ms }]（按需调度的 flush 窗口）
    eventSources: [],
    fetchCalls: [],
    warnings: [],
    trackingCalls: [] // Citrine.debug_tracking= 的入参
  };

  const validRoots = new Set();
  if (opts.devtoolsRoot) {
    validRoots.add(opts.devtoolsRoot); // Node 形式（$children）
    if (typeof opts.devtoolsRoot.$root === "function") validRoots.add(opts.devtoolsRoot.$root()); // 组件实例形式
  }
  if (opts.renderer) {
    if (opts.renderer.root) validRoots.add(opts.renderer.root);
    if (opts.renderer.ivarRoot) validRoots.add(opts.renderer.ivarRoot);
  }

  const opal = {
    nil: { $$is_nil: true },
    hash(...args) {
      const obj = {};
      for (let i = 0; i < args.length; i += 2) obj[args[i]] = args[i + 1];
      return rbHash(obj);
    },
    Citrine: {
      VERSION: "0.2.0",
      "$debug_tracking=": (v) => records.trackingCalls.push(v),
      $const_get: (name) => (name === "VERSION" ? "0.2.0" : undefined),
      $debug_write_log: () => rbRing(opts.rings.write),
      $debug_flush_trace: () => rbRing(opts.rings.flush),
      $debug_event_stream: () => rbRing(opts.rings.event),
      $debug_dependency_graph: () => rbHash(opts.graph),
      $debug_component_tree: (root) => {
        if (!validRoots.has(root)) throw new Error("debug_component_tree 收到了非预期的根节点");
        return rbHash(opts.tree);
      },
      Signal: {
        $all: () =>
          opts.signals.map((s) => ({
            $object_id: () => s.id,
            $set: (v) => {
              s.setCalls.push(v);
              if (s.throwOnSet) throw new Error("set 炸了");
            }
          }))
      },
      Effect: {
        $all: () =>
          opts.effects.map((e) => ({
            $object_id: () => e.id,
            $run: () => {
              e.runCalls += 1;
            }
          }))
      }
    }
  };
  if (opts.renderer) {
    opal.Citrine.$renderer = () => ({
      $respond_to: (name) => opts.renderer.rootNodeMethod === true && name === "root_node",
      $root_node: () => opts.renderer.root,
      $instance_variable_get: (name) =>
        name === "@root" && opts.renderer.ivarRoot ? opts.renderer.ivarRoot : null
    });
  }

  const sandbox = {
    console: { warn: (...args) => records.warnings.push(args.join(" ")) },
    setInterval: (fn, ms) => {
      records.intervals.push({ fn, ms });
      return records.intervals.length;
    },
    clearInterval: () => {},
    setTimeout: (fn, ms) => {
      records.timeouts.push({ fn, ms });
      return records.timeouts.length;
    },
    clearTimeout: () => {},
    fetch:
      opts.fetchImpl ||
      ((url, init) => {
        records.fetchCalls.push({ url, init });
        return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
      }),
    Opal: opts.opal ? opal : undefined,
    EventSource: undefined
  };
  if (opts.documentTitle !== undefined) sandbox.document = { title: opts.documentTitle };

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.onopen = null;
      this.onmessage = null;
      records.eventSources.push(this);
    }
    open() { this.onopen && this.onopen({}); }
    message(data) { this.onmessage && this.onmessage({ data }); }
  }
  sandbox.EventSource = FakeEventSource;

  sandbox.window = {
    CITRINE_DEV: opts.citrineDev,
    CITRINE_DEVTOOLS_URL: opts.relayUrl,
    CITRINE_DEVTOOLS_ROOT: opts.devtoolsRoot,
    Opal: sandbox.Opal,
    console: sandbox.console
  };

  vm.createContext(sandbox);
  vm.runInContext(BRIDGE_SOURCE, sandbox, { filename: "bridge.js" });

  const intervalWith = (ms) => records.intervals.find((t) => t.ms === ms);

  return {
    records,
    sandbox,
    // 协议：每 100ms 采集
    poll: () => intervalWith(100).fn(),
    // 协议：另 50ms 聚合窗口（enqueue 按需调度，驱动它即跑 flush）
    flush: () => {
      for (let guard = 0; guard < 10 && records.timeouts.length; guard += 1) {
        records.timeouts.shift().fn();
      }
    },
    connect: () => records.eventSources[0].open(),
    streamMessage: (msg) => records.eventSources[0].message(JSON.stringify(msg)),
    settle: () => new Promise((resolve) => setImmediate(resolve))
  };
}

// 取最近一次 ingest 请求解析后的信封 { v, messages }
async function lastIngest(h) {
  await h.settle();
  const ingestCalls = h.records.fetchCalls.filter((c) => c.url.endsWith("/__devtools/ingest"));
  assert.ok(ingestCalls.length > 0, "应有 ingest POST");
  return JSON.parse(ingestCalls[ingestCalls.length - 1].init.body);
}

// ── 激活与启动 ────────────────────────────────────────────

test("SSR（无 window）加载不启动、不抛错", () => {
  const sandbox = {
    setInterval: () => 1,
    EventSource: function () { throw new Error("不应构造 EventSource"); },
    fetch: () => { throw new Error("不应 fetch"); }
  };
  vm.createContext(sandbox);
  assert.doesNotThrow(() => vm.runInContext(BRIDGE_SOURCE, sandbox));
});

test("window 存在但缺 CITRINE_DEV 或缺 Opal 时不启动", () => {
  for (const opal of [true, false]) {
    const h = makeHarness({ citrineDev: false, opal });
    assert.equal(h.records.eventSources.length, 0);
    assert.equal(h.records.intervals.length, 0);
    assert.equal(h.records.fetchCalls.length, 0);
  }
  {
    const h = makeHarness({ citrineDev: true, opal: false });
    assert.equal(h.records.eventSources.length, 0);
    assert.equal(h.records.intervals.length, 0);
  }
});

test("激活：注册 100ms 采集定时器，SSE 连 /__devtools/stream，并打开 debug_tracking", () => {
  const h = makeHarness();
  assert.deepEqual(h.records.intervals.map((t) => t.ms), [100]);
  assert.equal(h.records.eventSources.length, 1);
  assert.equal(h.records.eventSources[0].url, "http://127.0.0.1:9527/__devtools/stream");
  assert.deepEqual(h.records.trackingCalls, [true]); // 桥接是页面调试代理，负责开探针
});

test("同一页面二次求值不起第二个桥接实例（Emerald 热更新防重）", () => {
  const h = makeHarness();
  vm.runInContext(BRIDGE_SOURCE, h.sandbox, { filename: "bridge.js" });
  assert.equal(h.records.eventSources.length, 1);
  assert.equal(h.records.intervals.length, 1);
});

// ── 中继地址 ──────────────────────────────────────────────

test("CITRINE_DEVTOOLS_URL 覆盖默认地址，容忍尾斜杠", () => {
  const h = makeHarness({ relayUrl: "http://127.0.0.1:49999/" });
  assert.equal(h.records.eventSources[0].url, "http://127.0.0.1:49999/__devtools/stream");
});

// ── hello ────────────────────────────────────────────────

test("SSE open 后经 ingest 上报 hello（v:1，app_name 取 document.title，citrine_version 取 VERSION）", async () => {
  const h = makeHarness({ documentTitle: "calculator" });
  h.connect();
  assert.equal(h.records.timeouts.length, 1);
  assert.ok(h.records.timeouts[0].ms >= 0 && h.records.timeouts[0].ms <= 50); // 首个 flush 窗口 ≤50ms
  h.flush();
  const envelope = await lastIngest(h);
  assert.equal(envelope.v, 1);
  assert.equal(envelope.messages.length, 1);
  const hello = envelope.messages[0];
  assert.equal(hello.type, "hello");
  assert.equal(hello.v, 1);
  assert.equal(hello.app_name, "calculator");
  assert.equal(hello.citrine_version, "0.2.0");
});

test("hello 可选字段：无 document.title 时省略 app_name 键", async () => {
  const h = makeHarness();
  h.connect();
  h.flush();
  const envelope = await lastIngest(h);
  const hello = envelope.messages[0];
  assert.equal(hello.type, "hello");
  assert.ok(!("app_name" in hello));
  assert.equal(hello.citrine_version, "0.2.0");
});

test("hello 幂等：SSE 重连（二次 open）允许再发一次", async () => {
  const h = makeHarness();
  h.connect();
  h.flush();
  const first = h.records.fetchCalls.length;
  h.records.eventSources[0].open(); // 重连
  h.flush();
  const envelope = await lastIngest(h);
  assert.equal(envelope.messages[0].type, "hello");
  assert.ok(h.records.fetchCalls.length > first);
});

// ── 采集与去重 ─────────────────────────────────────────────

test("三个 ring 的条目映射为 signal_write / flush / event 消息，信封 {v:1, messages:[…]}", async () => {
  const h = makeHarness({
    rings: {
      write: [rbHash({ t: 1.5, signal_id: 11, old: 0, new: 1, source: "external" })],
      flush: [rbHash({ flush_id: 3, t: 2.5, effects: [{ effect_id: 7, runs: 2, duration_ms: 0.4 }], trigger_signal_ids: [11] })],
      event: [rbHash({ t: 3.5, event_type: "click", target_component: "Counter", component_id: 21, handler_name: "increment", flush_ids: [3] })]
    }
  });
  h.poll();
  assert.equal(h.records.fetchCalls.length, 0); // 采集只入队，flush 窗口未到零 POST
  h.flush();
  const envelope = await lastIngest(h);
  assert.equal(envelope.v, 1);
  const types = envelope.messages.map((m) => m.type).sort();
  assert.deepEqual(types, ["event", "flush", "signal_write"]);
  const write = envelope.messages.find((m) => m.type === "signal_write");
  assert.equal(write.signal_id, 11);
  assert.equal(write.old, 0);
  assert.equal(write.new, 1);
  const flush = envelope.messages.find((m) => m.type === "flush");
  assert.equal(flush.flush_id, 3);
  assert.deepEqual(flush.trigger_signal_ids, [11]);
  const event = envelope.messages.find((m) => m.type === "event");
  assert.equal(event.handler_name, "increment");
  assert.equal(event.flush_ids[0], 3);
});

test("去重：重复 poll 不重复上报", async () => {
  const h = makeHarness({
    rings: { write: [rbHash({ t: 1, signal_id: 1, old: 0, new: 1, source: "external" })], flush: [], event: [] }
  });
  h.poll();
  h.flush();
  await lastIngest(h);
  const callsAfterFirst = h.records.fetchCalls.length;
  h.poll(); // 同一份条目再读一次
  h.flush();
  await h.settle();
  assert.equal(h.records.fetchCalls.length, callsAfterFirst); // 无新增 POST
});

test("去重：ring 滚动（丢旧增新）只上报新条目", async () => {
  const ringItems = [rbHash({ t: 1, signal_id: 1, old: 0, new: 1, source: "external" })];
  const h = makeHarness({ rings: { write: ringItems, flush: [], event: [] } });
  // ring 读取闭包捕获数组引用，原地修改即模拟 ring 滚动
  h.poll();
  h.flush();
  await lastIngest(h);
  h.records.fetchCalls.length = 0;

  ringItems.shift(); // 最旧条目被挤出 ring
  ringItems.push(rbHash({ t: 2, signal_id: 2, old: 1, new: 2, source: "external" }));
  h.poll();
  h.flush();
  const envelope = await lastIngest(h);
  assert.equal(envelope.messages.length, 1);
  assert.equal(envelope.messages[0].signal_id, 2);
});

test("聚合窗口：窗口内多次 poll 合并为一次 POST；flush 间隔被限在 50ms 窗口内；空窗口不发请求", async () => {
  const items = [rbHash({ t: 1, signal_id: 1, old: 0, new: 1, source: "external" })];
  const h = makeHarness({ rings: { write: items, flush: [], event: [] } });
  h.poll();
  items.push(rbHash({ t: 2, signal_id: 1, old: 1, new: 2, source: "external" }));
  h.poll(); // 同一窗口内第二次采集
  assert.equal(h.records.fetchCalls.length, 0);
  assert.equal(h.records.timeouts.length, 1); // 窗口内重复入队不重复调度
  h.flush();
  const envelope = await lastIngest(h);
  assert.equal(envelope.messages.length, 2); // 两批条目合并进一次 POST

  items.push(rbHash({ t: 3, signal_id: 1, old: 2, new: 3, source: "external" }));
  h.poll(); // 新窗口：距上次 flush 的间隔被限在 50ms 以内
  assert.equal(h.records.timeouts.length, 1);
  assert.ok(h.records.timeouts[0].ms > 0 && h.records.timeouts[0].ms <= 50);
  h.flush();
  const second = await lastIngest(h);
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].t, 3); // 新窗口的条目单独成批

  const callsAfterSecond = h.records.fetchCalls.length;
  h.flush(); // 无新入队：无调度、无请求
  await h.settle();
  assert.equal(h.records.fetchCalls.length, callsAfterSecond);
});

// ── 静默降级 ─────────────────────────────────────────────

test("上报故障静默降级：warn 恰好一次，不抛异常，恢复后继续上报", async () => {
  const items = [rbHash({ t: 1, signal_id: 1, old: 0, new: 1, source: "external" })];
  let shouldFail = true;
  const h = makeHarness({
    rings: { write: items, flush: [], event: [] },
    fetchImpl: (url, init) => {
      h.records.fetchCalls.push({ url, init });
      return shouldFail ? Promise.reject(new Error("连接被拒")) : Promise.resolve({ ok: true, status: 200 });
    }
  });
  h.poll();
  h.flush();
  await h.settle();
  h.poll();
  h.flush(); // 第二次失败：warn 仍只应有一次
  await h.settle();
  assert.equal(h.records.warnings.length, 1);
  assert.match(h.records.warnings[0], /上报失败.*静默降级/);

  shouldFail = false;
  items.push(rbHash({ t: 2, signal_id: 1, old: 1, new: 2, source: "external" }));
  h.poll();
  h.flush();
  const envelope = await lastIngest(h);
  assert.equal(envelope.messages[0].new, 2); // 降级解除后正常上行
});

test("HTTP 非 2xx 也按上报失败降级（warn 一次）", async () => {
  const h = makeHarness({
    rings: { write: [rbHash({ t: 1, signal_id: 1, old: 0, new: 1, source: "external" })], flush: [], event: [] },
    fetchImpl: (url, init) => {
      h.records.fetchCalls.push({ url, init });
      return Promise.resolve({ ok: false, status: 500 });
    }
  });
  h.poll();
  h.flush();
  await h.settle();
  assert.equal(h.records.warnings.length, 1);
  assert.match(h.records.warnings[0], /HTTP 500/);
});

// ── 指令：set_signal / force_rerun / request_graph / request_tree / highlight_node ──

test("cmd set_signal：按 object_id 命中 Signal.all 并 $set（标量直通、null→Opal.nil）", async () => {
  const signal = { id: 42, setCalls: [] };
  const h = makeHarness({ signals: [signal] });
  h.streamMessage({ v: 1, type: "cmd", cmd: "set_signal", signal_id: 42, value: 5 });
  await h.settle();
  assert.deepEqual(signal.setCalls, [5]);

  h.streamMessage({ v: 1, type: "cmd", cmd: "set_signal", signal_id: 42, value: null });
  await h.settle();
  assert.equal(signal.setCalls.length, 2);
  assert.equal(signal.setCalls[1], h.sandbox.Opal.nil);
  // 成功路径不回 ACK、零上行（写入会经采集循环以 signal_write 形式自然回流）
  assert.equal(h.records.fetchCalls.length, 0);
});

test("cmd set_signal：对象值经 Opal.hash 转换", async () => {
  const signal = { id: 42, setCalls: [] };
  const h = makeHarness({ signals: [signal] });
  h.streamMessage({ v: 1, type: "cmd", cmd: "set_signal", signal_id: 42, value: { a: 1, list: [1, "x"] } });
  await h.settle();
  assert.equal(signal.setCalls.length, 1);
  assert.equal(typeof signal.setCalls[0].$to_n, "function");
  assert.deepEqual(signal.setCalls[0].$to_n(), { a: 1, list: [1, "x"] });
});

test("cmd set_signal：未命中回 {type:error, cmd, error}", async () => {
  const h = makeHarness({ signals: [] });
  h.streamMessage({ v: 1, type: "cmd", cmd: "set_signal", signal_id: 999, value: 1 });
  h.flush();
  const envelope = await lastIngest(h);
  const error = envelope.messages.find((m) => m.type === "error");
  assert.equal(error.cmd, "set_signal");
  assert.match(error.error, /找不到 signal/);
});

test("cmd force_rerun：命中 $run，未命中回 error", async () => {
  const effect = { id: 77, runCalls: 0 };
  const h = makeHarness({ effects: [effect] });
  h.streamMessage({ v: 1, type: "cmd", cmd: "force_rerun", effect_id: 77 });
  h.streamMessage({ v: 1, type: "cmd", cmd: "force_rerun", effect_id: 404 });
  h.flush();
  const envelope = await lastIngest(h);
  assert.equal(effect.runCalls, 1);
  const error = envelope.messages.find((m) => m.type === "error");
  assert.equal(error.cmd, "force_rerun");
  assert.match(error.error, /找不到 effect/);
});

test("cmd request_graph：回 graph 消息，载荷为依赖图快照", async () => {
  const h = makeHarness({ graph: { signals: [{ id: 1, subscribers: 2 }], effects: [{ id: 3, runs: 4, disposed: false }] } });
  h.streamMessage({ v: 1, type: "cmd", cmd: "request_graph" });
  h.flush();
  const envelope = await lastIngest(h);
  const graph = envelope.messages.find((m) => m.type === "graph");
  assert.equal(graph.v, 1);
  assert.deepEqual(graph.signals, [{ id: 1, subscribers: 2 }]);
  assert.equal(graph.effects[0].runs, 4);
});

test("cmd request_tree：渲染器有 root_node 方法时（beryl 入口）回 tree 快照", async () => {
  const rootNode = { $$is_node: true };
  const tree = { node_id: 9, component: "Shell", props: {}, state: {}, computed: {}, children: [] };
  const h = makeHarness({ renderer: { rootNodeMethod: true, root: rootNode, ivarRoot: null }, tree });
  h.streamMessage({ v: 1, type: "cmd", cmd: "request_tree" });
  h.flush();
  const envelope = await lastIngest(h);
  const msg = envelope.messages.find((m) => m.type === "tree");
  assert.deepEqual(msg.node_id, 9);
  assert.deepEqual(msg.component, "Shell");
  assert.deepEqual(msg.children, []);
});

test("cmd request_tree：Canvas 渲染器 @root 实例变量路径", async () => {
  const ivarRoot = { $$is_node: true };
  const h = makeHarness({ renderer: { rootNodeMethod: false, root: null, ivarRoot } });
  h.streamMessage({ v: 1, type: "cmd", cmd: "request_tree" });
  h.flush();
  const envelope = await lastIngest(h);
  assert.ok(envelope.messages.some((m) => m.type === "tree"));
});

test("cmd request_tree：window.CITRINE_DEVTOOLS_ROOT 优先（组件实例形式）", async () => {
  const rootNode = { $$is_node: true };
  const providedComponent = { $root: () => rootNode };
  const h = makeHarness({
    devtoolsRoot: providedComponent,
    renderer: { rootNodeMethod: true, root: { $$is_node: "别的根" }, ivarRoot: null }
  });
  h.streamMessage({ v: 1, type: "cmd", cmd: "request_tree" });
  h.flush();
  const envelope = await lastIngest(h);
  assert.ok(envelope.messages.some((m) => m.type === "tree")); // mock 只对预期根节点不抛错
});

test("cmd request_tree：找不到根节点时回 error", async () => {
  const h = makeHarness();
  h.streamMessage({ v: 1, type: "cmd", cmd: "request_tree" });
  h.flush();
  const envelope = await lastIngest(h);
  const error = envelope.messages.find((m) => m.type === "error");
  assert.equal(error.cmd, "request_tree");
  assert.match(error.error, /找不到渲染根节点/);
});

test("cmd highlight_node：v1 未实现，回固定文案 error", async () => {
  const h = makeHarness();
  h.streamMessage({ v: 1, type: "cmd", cmd: "highlight_node", node_id: 9 });
  h.flush();
  const envelope = await lastIngest(h);
  const error = envelope.messages.find((m) => m.type === "error");
  assert.equal(error.cmd, "highlight_node");
  assert.equal(error.error, "highlight_node 未实现（M3）");
});

test("cmd 执行异常：回 {type:error, cmd, error} 且不抛出", async () => {
  const signal = { id: 42, setCalls: [], throwOnSet: true };
  const h = makeHarness({ signals: [signal] });
  assert.doesNotThrow(() => h.streamMessage({ v: 1, type: "cmd", cmd: "set_signal", signal_id: 42, value: 1 }));
  h.flush();
  const envelope = await lastIngest(h);
  const error = envelope.messages.find((m) => m.type === "error");
  assert.equal(error.cmd, "set_signal");
  assert.match(error.error, /set 炸了/);
});

// ── 忽略规则 ──────────────────────────────────────────────

test("忽略：自身上报回声的 type、未知 type、v!==1、非 JSON、畸形 cmd 消息", async () => {
  const h = makeHarness();
  h.streamMessage({ v: 1, type: "signal_write", t: 1, signal_id: 1, old: 0, new: 1, source: "external" });
  h.streamMessage({ v: 1, type: "bogus", x: 1 });
  h.streamMessage({ v: 2, type: "cmd", cmd: "set_signal", signal_id: 1, value: 1 });
  h.streamMessage("not json at all");
  h.streamMessage({ v: 1, type: "cmd" }); // 缺 cmd 字段：非法协议消息，静默忽略
  h.flush();
  await h.settle();
  assert.equal(h.records.fetchCalls.length, 0); // 无任何上行（也没有 error 回报）
});

test("未知 cmd：回 error 提示版本错配", async () => {
  const h = makeHarness();
  h.streamMessage({ v: 1, type: "cmd", cmd: "teleport", x: 1 });
  h.flush();
  const envelope = await lastIngest(h);
  const error = envelope.messages.find((m) => m.type === "error");
  assert.equal(error.cmd, "teleport");
  assert.match(error.error, /未知指令/);
});

// ── 端到端：真实 HTTP 服务（端口 0）+ 真实 fetch 验证券面 ──────

test("端到端：POST /__devtools/ingest 经真实 HTTP 收到 {v:1, messages:[…]}", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const h = makeHarness({
      relayUrl: `http://127.0.0.1:${port}`,
      rings: { write: [rbHash({ t: 1, signal_id: 1, old: 0, new: 1, source: "external" })], flush: [], event: [] },
      fetchImpl: (url, init) => {
        h.records.fetchCalls.push({ url, init });
        return fetch(url, init);
      }
    });
    h.connect();
    h.poll();
    h.flush();
    // 等真实 HTTP 请求到达（不定型 setImmediate 次数，直接轮询到收到或超时）
    const deadline = Date.now() + 2000;
    while (requests.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(h.records.fetchCalls.length, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/__devtools/ingest");
    const envelope = JSON.parse(requests[0].body);
    assert.equal(envelope.v, 1);
    const types = envelope.messages.map((m) => m.type);
    assert.ok(types.includes("hello"));
    assert.ok(types.includes("signal_write"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
