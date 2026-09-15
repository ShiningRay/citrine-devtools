// citrine-devtools Timeline / Inspector 视图模型测试（node:test，vm 沙箱加载 panel.js，
// 与 panel_model_test.mjs 同款办法：module.exports 分支导出纯函数，浏览器 DOM 分支不执行）
//
// 覆盖 M4 收尾协作契约：
//   Timeline：formatTimelineTime（HH:MM:SS.mmm）/ trimBuffer（环形截断）/ flushTotalMs（求和宽容）/
//     laneOf（事件/flush/信号短号/其他信号）/ buildTimelineRows（最新在上、行模型 time/lane/label/kind/links、
//     event→flush 关联、flush 行 id = "flush#<id>"、8 泳道上限、时间戳回退口径、畸形宽容）/
//   Inspector：parseLooseValue（数字/布尔/null/JSON 对象/引号串/裸字符串/非法 JSON 串/数字字面量回退）/
//     inspectorEffectFor（第一个未 dispose 的依赖 effect）/ receiptState（awaiting/confirmed/timeout）/
//   panel.html 静态契约（Timeline 标签页与容器 / Inspector 详情条元素 / .tl-row、.linked、tr.selected 样式）
//
// 运行：node --test   （或 npm test）
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.join(fileURLToPath(new URL(".", import.meta.url)));
const PANEL_SOURCE = readFileSync(path.join(HERE, "../lib/citrine-devtools/panel.js"), "utf8");
const PANEL_HTML = readFileSync(path.join(HERE, "../lib/citrine-devtools/panel.html"), "utf8");

function loadPanel() {
  const sandbox = { module: { exports: {} }, console };
  vm.createContext(sandbox);
  vm.runInContext(PANEL_SOURCE, sandbox);
  return sandbox.module.exports;
}

const panel = loadPanel();

// vm 沙箱跨 realm：deepStrictEqual 会比较原型，先 JSON 回转成本地对象再比较
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── formatTimelineTime ────────────────────────────────────

test("formatTimelineTime：HH:MM:SS.mmm，非法输入兜底", () => {
  const t = new Date(2026, 8, 15, 9, 5, 3, 7).getTime();
  assert.equal(panel.formatTimelineTime(t), "09:05:03.007");
  assert.equal(panel.formatTimelineTime(new Date(2026, 8, 15, 23, 59, 59, 999).getTime()), "23:59:59.999");
  assert.equal(panel.formatTimelineTime(-1), "--:--:--.---");
  assert.equal(panel.formatTimelineTime(NaN), "--:--:--.---");
  assert.equal(panel.formatTimelineTime(undefined), "--:--:--.---");
});

// ── trimBuffer ────────────────────────────────────────────

test("trimBuffer：环形丢最旧留最新，非法 cap 不动", () => {
  const buf = [1, 2, 3, 4, 5];
  assert.equal(panel.trimBuffer(buf, 3), buf); // 原址返回
  assert.deepEqual(buf, [3, 4, 5]);
  assert.deepEqual(panel.trimBuffer([1, 2], 10), [1, 2]); // 未超不裁
  assert.deepEqual(panel.trimBuffer([1, 2], 0), [1, 2]); // cap 0 = 不裁
  assert.deepEqual(panel.trimBuffer([1, 2], -1), [1, 2]);
  assert.equal(panel.trimBuffer(null, 3), null);
});

// ── flushTotalMs / laneOf ─────────────────────────────────

test("flushTotalMs：duration_ms 求和，缺字段/裸 id 按 0", () => {
  assert.equal(panel.flushTotalMs([{ effect_id: 1, runs: 2, duration_ms: 5 },
                                    { effect_id: 2, runs: 1, duration_ms: 7.5 }]), 12.5);
  assert.equal(panel.flushTotalMs([1, 2]), 0); // M1 线格式：裸 id 数组
  assert.equal(panel.flushTotalMs([{ duration_ms: "x" }, {}]), 0);
  assert.equal(panel.flushTotalMs(null), 0);
  assert.equal(panel.flushTotalMs([]), 0);
});

test("laneOf：事件/flush 固定泳道，信号查映射，无命中归「其他信号」", () => {
  assert.equal(panel.laneOf({ kind: "event" }), "事件");
  assert.equal(panel.laneOf({ kind: "flush" }), "flush");
  const lanes = new Map([["11112222", "#2222"]]);
  assert.equal(panel.laneOf({ kind: "signal_write", signal_id: 11112222 }, lanes), "#2222");
  assert.equal(panel.laneOf({ kind: "signal_write", signal_id: 9999 }, lanes), "其他信号"); // 超 8 个的信号
  assert.equal(panel.laneOf({ kind: "signal_write" }, lanes), "其他信号"); // 缺 signal_id
  assert.equal(panel.laneOf({ kind: "signal_write", signal_id: 11112222 }), "其他信号"); // 无映射参数
  assert.equal(panel.laneOf(null), "其他信号");
});

// ── buildTimelineRows ─────────────────────────────────────

const T0 = new Date(2026, 8, 15, 12, 0, 0).getTime();

function ev(seq, receivedAt, flushIds) {
  return { v: 1, type: "event", t: 1.5, seq, event_type: "click", target_component: "Counter",
           handler_name: "increment", flush_ids: flushIds, receivedAt };
}
function fl(seq, receivedAt, flushId, effects) {
  return { v: 1, type: "flush", t: 1.5, seq, flush_id: flushId, effects,
           trigger_signal_ids: [11112222], receivedAt };
}
function wr(seq, receivedAt, signalId, oldV, newV) {
  return { v: 1, type: "signal_write", t: 1.5, seq, signal_id: signalId,
           old: oldV, new: newV, source: "external", receivedAt };
}

test("buildTimelineRows：最新在上，行模型 time/lane/label/kind/links 齐全", () => {
  const rows = panel.buildTimelineRows(
    [ev(0, T0 + 1000, [7])],
    [fl(1, T0 + 1100, 7, [{ effect_id: 91, runs: 2, duration_ms: 5 },
                          { effect_id: 92, runs: 1, duration_ms: 7 }])],
    [wr(2, T0 + 1200, 11112222, 0, 5)],
    T0
  );
  assert.equal(rows.length, 3);
  // 时间降序：write(1200) → flush(1100) → event(1000)
  assert.deepEqual(plain(rows.map((r) => r.time)), [T0 + 1200, T0 + 1100, T0 + 1000]);
  assert.deepEqual(plain(rows.map((r) => r.kind)), ["signal_write", "flush", "event"]);

  const [writeRow, flushRow, eventRow] = rows;
  assert.equal(writeRow.lane, "#2222"); // 短号泳道
  assert.equal(writeRow.label, "0 → 5");
  assert.deepEqual(plain(writeRow.links), []);

  assert.equal(flushRow.id, "flush#7"); // flush 行 id 口径：event 关联高亮的锚
  assert.equal(flushRow.lane, "flush");
  assert.equal(flushRow.label, "2 fx · 12ms"); // fx 数量 + 总耗时

  assert.equal(eventRow.id, "event#2");
  assert.equal(eventRow.lane, "事件");
  assert.equal(eventRow.label, "click @Counter · increment");
  assert.deepEqual(plain(eventRow.links), ["flush#7"]); // 关联 flush 行 id
});

test("buildTimelineRows：同毫秒时间戳按到达序号排（seq 大者在上）", () => {
  const rows = panel.buildTimelineRows([ev(1, T0, [7])], [fl(0, T0, 7, [])], [], T0);
  assert.deepEqual(plain(rows.map((r) => r.id)), ["event#0", "flush#7"]); // seq 1 的 event 在上；flush 行 id = flush#<flush_id>
});

test("buildTimelineRows：信号泳道 8 个上限，超出归「其他信号」", () => {
  const writes = [];
  for (let i = 0; i < 10; i++) writes.push(wr(i, T0 + i, 100 + i, 0, 1));
  const rows = panel.buildTimelineRows([], [], writes, T0);
  assert.equal(rows.length, 10);
  const lanes = rows.map((r) => r.lane);
  // 前 8 个信号（100–107）各占短号泳道，后 2 个（108/109）归「其他信号」
  assert.ok(lanes.includes("#100"));
  assert.ok(lanes.includes("#107"));
  assert.ok(!lanes.includes("#108"));
  assert.equal(rows.filter((r) => r.lane === "其他信号").length, 2);
});

test("buildTimelineRows：时间戳口径 receivedAt → t（秒）→ now 回退", () => {
  const now = T0 + 9999;
  const rows = panel.buildTimelineRows(
    [{ v: 1, type: "event", t: 1700000000.5, event_type: "click", target_component: "C",
       handler_name: null, flush_ids: [], seq: 0 }], // 无 receivedAt → t*1000
    [],
    [wr(0, null, 11112222, null, 1)], // 无 receivedAt（t 也不合法）→ now
    now
  );
  const eventRow = rows.find((r) => r.kind === "event");
  const writeRow = rows.find((r) => r.kind === "signal_write");
  assert.equal(eventRow.time, 1700000000500);
  assert.equal(writeRow.time, now);
  assert.equal(writeRow.label, "nil → 1"); // nil 值预览
});

test("buildTimelineRows：畸形宽容", () => {
  assert.deepEqual(plain(panel.buildTimelineRows(null, null, null, 0)), []);
  const rows = panel.buildTimelineRows([null, { kind: "event" }], [{ kind: "flush" }], ["x"], 0);
  assert.equal(rows.length, 2); // null 条目跳过，非对象写入跳过
});

// ── parseLooseValue ───────────────────────────────────────

test("parseLooseValue：JSON 优先（数字/布尔/null/对象/数组/引号串）", () => {
  assert.equal(panel.parseLooseValue("42"), 42);
  assert.equal(panel.parseLooseValue("-3.5"), -3.5);
  assert.equal(panel.parseLooseValue("1e3"), 1000);
  assert.equal(panel.parseLooseValue("true"), true);
  assert.equal(panel.parseLooseValue("false"), false);
  assert.equal(panel.parseLooseValue("null"), null);
  assert.deepEqual(plain(panel.parseLooseValue('{"a":1}')), { a: 1 });
  assert.deepEqual(plain(panel.parseLooseValue("[1,2]")), [1, 2]);
  assert.equal(panel.parseLooseValue('"hi"'), "hi");
});

test("parseLooseValue：JSON 解析失败退数字字面量，再退原样 string", () => {
  assert.equal(panel.parseLooseValue("07"), 7); // JSON.parse 不接受前导零，数字正则接住
  assert.equal(panel.parseLooseValue(".5"), 0.5);
  assert.equal(panel.parseLooseValue("abc"), "abc"); // 裸字符串原样
  assert.equal(panel.parseLooseValue("{bad json"), "{bad json"); // 非法 JSON 串原样
  assert.equal(panel.parseLooseValue("undefined"), "undefined");
  assert.equal(panel.parseLooseValue(""), "");
  assert.equal(panel.parseLooseValue("   "), "");
  assert.equal(panel.parseLooseValue(42), 42); // 非字符串输入原样
  assert.equal(panel.parseLooseValue(null), "");
});

// ── inspectorEffectFor / receiptState ─────────────────────

const GRAPH = {
  v: 1, type: "graph",
  signals: [{ id: 11112222, subscribers: 2 }],
  effects: [
    { id: 91, deps: [11112222], runs: 7, disposed: false },
    { id: 92, deps: [11112222], runs: 3, disposed: false },
    { id: 93, deps: [11112222], runs: 1, disposed: true }
  ]
};

test("inspectorEffectFor：第一个未 dispose 的依赖 effect；无依赖 → null", () => {
  assert.equal(panel.inspectorEffectFor(GRAPH, 11112222), 91); // 第一个命中，disposed 的 93 被跳过
  assert.equal(panel.inspectorEffectFor(GRAPH, 9999), null);
  assert.equal(panel.inspectorEffectFor(null, 11112222), null);
  const disposedOnly = { v: 1, type: "graph", signals: [], effects: [
    { id: 93, deps: [11112222], runs: 1, disposed: true }
  ] };
  assert.equal(panel.inspectorEffectFor(disposedOnly, 11112222), null);
});

test("receiptState：awaiting / confirmed / timeout（含迟达回执）", () => {
  assert.equal(panel.receiptState(1000, null, 1500, 2000), "awaiting");
  assert.equal(panel.receiptState(1000, 1200, 1200, 2000), "confirmed");
  assert.equal(panel.receiptState(1000, null, 3200, 2000), "timeout");
  assert.equal(panel.receiptState(1000, 3500, 3500, 2000), "timeout"); // 回执超窗也算超时
  assert.equal(panel.receiptState(1000, 1500, 1500), "confirmed"); // 默认窗口 2000ms
  assert.equal(panel.receiptState(1000, null, 1000, 2000), "awaiting"); // 边界：刚到窗口未超
});

// ── panel.html 静态契约 ───────────────────────────────────

test("panel.html：Timeline 标签页 / Inspector 详情条 / 高亮与选中样式", () => {
  assert.match(PANEL_HTML, /data-tab="timeline"/); // 第四个标签页按钮
  assert.match(PANEL_HTML, /Timeline/);
  assert.match(PANEL_HTML, /id="view-timeline"/);
  assert.match(PANEL_HTML, /id="timeline"/);
  // Inspector 详情条（选中信号后出现）
  assert.match(PANEL_HTML, /id="inspector"/);
  assert.match(PANEL_HTML, /id="inspector-input"/);
  assert.match(PANEL_HTML, /id="inspector-write"/);
  assert.match(PANEL_HTML, /id="inspector-rerun"/);
  assert.match(PANEL_HTML, /id="inspector-status"/);
  // 样式契约
  assert.match(PANEL_HTML, /\.tl-row/);
  assert.match(PANEL_HTML, /\.tl-row\.linked/); // event 关联高亮的 flush 行
  assert.match(PANEL_HTML, /tr\.selected td/); // 信号表选中行
  assert.match(PANEL_HTML, /#inspector-status\.err/); // error 红色
  assert.match(PANEL_HTML, /#inspector\[hidden\]/); // flex 布局下 hidden 属性仍生效
});
