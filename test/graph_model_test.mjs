// citrine-devtools 依赖图标签页视图模型测试（node:test，vm 沙箱加载 panel.js，
// 与 panel_model_test.mjs 同款办法：module.exports 分支导出纯函数，浏览器 DOM 分支不执行）
//
// 覆盖 M4 协作契约：
//   buildGraphModel（signal/effect 节点 + signal→effect 边 / disposed 剔除 / 孤儿 dep 容忍 /
//     Map 与普通对象两种 writeCounts / 缺字段宽容）/
//   heatColor（0 → 灰蓝基础色，max → 高亮 accent，超 max 钳制，max 0 退化）/
//   graphSignature（结构变化与 runs 变化 → 签名变；heat（writes）变化 → 签名不变）/
//   maxWritesOf / applyHeatColors（heat 写入节点 data 供 cytoscape data() 映射）/
//   countOf（Map / 普通对象 / 非法值兜底）/
//   panel.html 静态契约（依赖图标签页 / #graph 容器 / cytoscape script 引用先于 panel.js）
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

const GRAPH = {
  v: 1,
  type: "graph",
  signals: [
    { id: 11112222, subscribers: 2 },
    { id: 33334444, subscribers: 0 }
  ],
  effects: [
    { id: 91, deps: [11112222], runs: 7, disposed: false },
    { id: 92, deps: [33334444, 99998888], runs: 3, disposed: false }, // 99998888 是孤儿 dep
    { id: 93, deps: [11112222], runs: 1, disposed: true }
  ]
};

// ── buildGraphModel ───────────────────────────────────────

test("buildGraphModel：signal/effect 节点与 signal→effect 边", () => {
  const els = panel.buildGraphModel(GRAPH, new Map([["11112222", 5]]));
  const nodes = els.filter((e) => e.group === "nodes");
  const edges = els.filter((e) => e.group === "edges");
  assert.equal(nodes.length, 4); // 2 signal + 2 effect（93 disposed 剔除）
  assert.equal(edges.length, 2); // 92→99998888 孤儿边剔除，93 的边随 disposed 剔除

  const s1 = nodes.find((n) => n.data.id === "s:11112222");
  assert.equal(s1.data.label, "#2222"); // 短号
  assert.equal(s1.data.kind, "signal");
  assert.equal(s1.data.subscribers, 2);
  assert.equal(s1.data.writes, 5); // writeCounts 累计进 data

  const e91 = nodes.find((n) => n.data.id === "e:91");
  assert.equal(e91.data.label, "fx#91 ×7"); // fx短号 + runs
  assert.equal(e91.data.kind, "effect");
  assert.equal(e91.data.runs, 7);

  assert.deepEqual(
    plain(edges.map((e) => [e.data.id, e.data.source, e.data.target])),
    [
      ["s:11112222|e:91", "s:11112222", "e:91"], // 边 signal→effect
      ["s:33334444|e:92", "s:33334444", "e:92"]
    ]
  );
});

test("buildGraphModel：disposed effect 整棵剔除，孤儿 dep 只跳过该边", () => {
  const els = panel.buildGraphModel(GRAPH, null);
  assert.ok(!els.some((e) => e.data && e.data.id === "e:93")); // 节点剔除
  assert.ok(!els.some((e) => e.group === "edges" && e.data.target === "e:93")); // 边随之剔除
  assert.ok(!els.some((e) => String(e.data && e.data.id).includes("99998888"))); // 孤儿 dep 不产生节点/边
  // 孤儿 dep 不影响同 effect 的其它边
  assert.ok(els.some((e) => e.group === "edges" && e.data.id === "s:33334444|e:92"));
});

test("buildGraphModel：畸形输入宽容（nil / 缺字段 / 非数组 deps）", () => {
  assert.deepEqual(plain(panel.buildGraphModel(null, null)), []);
  assert.deepEqual(plain(panel.buildGraphModel({}, [])), []);
  const els = panel.buildGraphModel({ signals: [{ id: 1 }, null], effects: [{ id: 2 }, { id: 3, deps: "nope" }] }, null);
  const nodes = els.filter((e) => e.group === "nodes");
  assert.equal(nodes.length, 3); // signal#1 + effect#2 + effect#3（null 信号跳过；无 deps 数组仍入图作孤立节点）
  assert.equal(nodes.find((n) => n.data.id === "s:1").data.subscribers, 0); // 缺 subscribers 兜底
  assert.equal(nodes.find((n) => n.data.id === "e:2").data.runs, 0); // 缺 runs 兜底
  assert.equal(nodes.find((n) => n.data.id === "e:3").data.runs, 0); // deps 非数组 → 无关联边
  assert.equal(els.filter((e) => e.group === "edges").length, 0);
});

test("countOf：Map / 普通对象都收，非法值按 0", () => {
  assert.equal(panel.countOf(null, 1), 0);
  assert.equal(panel.countOf(new Map([["1", 4]]), 1), 4); // 数字 id 转 String 键
  assert.equal(panel.countOf({ "1": 4 }, 1), 4);
  assert.equal(panel.countOf({ "1": "x" }, 1), 0);
  assert.equal(panel.countOf(new Map([["1", NaN]]), 1), 0);
  assert.equal(panel.countOf({}, 99), 0);
});

// ── heatColor ─────────────────────────────────────────────

test("heatColor：0 → 灰蓝基础色，max → 高亮 accent，超出钳制，max 0 退化", () => {
  assert.notEqual(panel.HEAT_BASE, panel.HEAT_ACCENT);
  assert.equal(panel.heatColor(0, 10), panel.HEAT_BASE);
  assert.equal(panel.heatColor(10, 10), panel.HEAT_ACCENT);
  assert.equal(panel.heatColor(99, 10), panel.HEAT_ACCENT); // 超 max 钳到 accent
  assert.equal(panel.heatColor(0, 0), panel.HEAT_BASE); // max 0 退化基础色
  assert.equal(panel.heatColor(3, 0), panel.HEAT_BASE);
  assert.equal(panel.heatColor(undefined, 10), panel.HEAT_BASE);

  const mid = panel.heatColor(5, 10);
  assert.match(mid, /^#[0-9a-f]{6}$/); // cytoscape style 可用的颜色串
  assert.notEqual(mid, panel.HEAT_BASE);
  assert.notEqual(mid, panel.HEAT_ACCENT);
  assert.equal(panel.heatColor(5, 10), mid); // 确定性
  // 单调趋近 accent：channel 值介于两端点之间
  const channel = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  for (let i = 0; i < 3; i++) {
    assert.ok(channel(mid, i) >= Math.min(channel(panel.HEAT_BASE, i), channel(panel.HEAT_ACCENT, i)));
    assert.ok(channel(mid, i) <= Math.max(channel(panel.HEAT_BASE, i), channel(panel.HEAT_ACCENT, i)));
  }
});

// ── graphSignature ────────────────────────────────────────

test("graphSignature：结构/runs 变化签名变，heat（writes）变化签名不变", () => {
  const counts = new Map([["11112222", 3]]);
  const sig1 = panel.graphSignature(panel.buildGraphModel(GRAPH, counts));
  assert.equal(sig1, panel.graphSignature(panel.buildGraphModel(GRAPH, counts))); // 确定性

  // heat 变化（writes 不在签名源里）→ 签名不变 → 面板只刷样式不重建
  const sigHeat = panel.graphSignature(panel.buildGraphModel(GRAPH, new Map([["11112222", 99], ["33334444", 5]])));
  assert.equal(sigHeat, sig1);

  // runs 变化 → 签名变 → 重建（runs 在签名源里）
  const gRuns = JSON.parse(JSON.stringify(GRAPH));
  gRuns.effects[0].runs = 8;
  assert.notEqual(panel.graphSignature(panel.buildGraphModel(gRuns, counts)), sig1);

  // 结构变化：新增信号 → 签名变
  const gNode = JSON.parse(JSON.stringify(GRAPH));
  gNode.signals.push({ id: 55556666, subscribers: 1 });
  assert.notEqual(panel.graphSignature(panel.buildGraphModel(gNode, counts)), sig1);

  // 结构变化：边改接（数量不变）→ 签名也变（边端点在签名源里）
  const gEdge = JSON.parse(JSON.stringify(GRAPH));
  gEdge.effects[1].deps = [11112222];
  assert.notEqual(panel.graphSignature(panel.buildGraphModel(gEdge, counts)), sig1);

  // 空模型宽容且稳定
  assert.equal(panel.graphSignature(null), panel.graphSignature([]));
});

// ── maxWritesOf / applyHeatColors ─────────────────────────

test("maxWritesOf / applyHeatColors：heat 写入节点 data（effect 无 writes → 基础色）", () => {
  const model = panel.buildGraphModel(GRAPH, new Map([["11112222", 4], ["33334444", 2]]));
  assert.equal(panel.maxWritesOf(model), 4);
  panel.applyHeatColors(model, 4);
  const byId = new Map(model.filter((e) => e.group === "nodes").map((n) => [n.data.id, n.data]));
  assert.equal(byId.get("s:11112222").heat, panel.HEAT_ACCENT); // 满热度
  assert.equal(byId.get("s:33334444").heat, panel.heatColor(2, 4)); // 半热度
  assert.equal(byId.get("e:91").heat, panel.HEAT_BASE); // effect 无 writes → 基础色

  assert.equal(panel.maxWritesOf(null), 0);
  assert.equal(panel.maxWritesOf([]), 0);
  const empty = [];
  assert.equal(panel.applyHeatColors(empty, 0), empty); // 宽容且原样返回
});

// ── panel.html 静态契约 ───────────────────────────────────

test("panel.html：依赖图标签页 / #graph 容器 / cytoscape script 先于 panel.js", () => {
  assert.match(PANEL_HTML, /data-tab="graph"/); // 第三个标签页按钮
  assert.match(PANEL_HTML, /依赖图/);
  assert.match(PANEL_HTML, /id="view-graph"/); // 页签 section（hidden 切换）
  assert.match(PANEL_HTML, /id="graph"/); // canvas 渲染容器
  assert.match(PANEL_HTML, /#graph \{ width: 100%; height: 100%; \}/); // 容器占满剩余空间
  assert.match(PANEL_HTML, /<script src="\/vendor\/cytoscape\.min\.js"><\/script>/);
  // cytoscape 先加载，panel.js 后加载（面板脚本读 window.cytoscape 做降级判断）
  const cyIdx = PANEL_HTML.indexOf("/vendor/cytoscape.min.js");
  const panelIdx = PANEL_HTML.indexOf("/panel.js");
  assert.ok(cyIdx !== -1 && panelIdx !== -1 && cyIdx < panelIdx);
});
