// citrine-devtools panel.js 纯函数视图模型测试（node:test，无第三方依赖）
//
// 覆盖 M3-B 面板协作契约：
//   消息校验（v 不符 / 非 JSON 忽略，PROTOCOL.md 口径）/ 短号 / HH:MM:SS 格式化 /
//   buildSignalsModel（graph 订阅数 + deps 关联 runs + signal_write 累计当前值·次数·时间）/
//   disposed effect 不参与 runs / 缺字段宽容 / changedRowKeys 闪烁行检出（首帧不闪）/
//   renderTreeLines（嵌套 children 缩进 + component #短号 + reuse_key）/
//   panel.html 静态契约（标题 / 标签页 / .flash / token / 引用 /panel.js）
//
// 运行：node --test   （或 npm test）
// 与 bridge_contract_test.mjs 同款 vm 沙箱加载：module.exports 分支导出纯函数，
// 浏览器 DOM 分支不执行（沙箱无 document）。
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

// ── 消息校验 ──────────────────────────────────────────────

test("isValidMessage / parseSSEData：v:1 + type 才收，非 JSON 忽略", () => {
  assert.equal(panel.isValidMessage({ v: 1, type: "tree" }), true);
  assert.equal(panel.isValidMessage({ v: 2, type: "tree" }), false); // v 不符
  assert.equal(panel.isValidMessage({ v: 1 }), false); // 缺 type
  assert.equal(panel.isValidMessage("tree"), false);
  assert.equal(panel.isValidMessage(null), false);

  assert.deepEqual(plain(panel.parseSSEData('{"v":1,"type":"tree"}')), { v: 1, type: "tree" });
  assert.equal(panel.parseSSEData("not json"), null); // 非 JSON 包一律忽略
  assert.equal(panel.parseSSEData('{"v":2,"type":"tree"}'), null); // v 不符忽略
});

// ── 显示辅助 ──────────────────────────────────────────────

test("shortId：object_id 末四位短号，nil 安全", () => {
  assert.equal(panel.shortId(12342222), "#2222");
  assert.equal(panel.shortId("abc9999"), "#9999");
  assert.equal(panel.shortId(42), "#42"); // 不足四位不补零
  assert.equal(panel.shortId(null), "#----");
  assert.equal(panel.shortId(undefined), "#----");
});

test("formatClock：epoch 毫秒 → HH:MM:SS（本地时），非法输入兜底", () => {
  const t = new Date(2026, 8, 15, 9, 5, 3).getTime();
  assert.equal(panel.formatClock(t), "09:05:03");
  assert.equal(panel.formatClock(new Date(2026, 8, 15, 23, 59, 59).getTime()), "23:59:59");
  assert.equal(panel.formatClock(-1), "--:--:--");
  assert.equal(panel.formatClock(NaN), "--:--:--");
  assert.equal(panel.formatClock(undefined), "--:--:--");
});

// ── buildSignalsModel ─────────────────────────────────────

const GRAPH = {
  v: 1,
  type: "graph",
  signals: [
    { id: 11112222, subscribers: 2 },
    { id: 33334444, subscribers: 0 }
  ],
  effects: [
    { id: 91, deps: [11112222], runs: 7, disposed: false },
    { id: 92, deps: [33334444, 99998888], runs: 3, disposed: false }
  ]
};

function write(signalId, newValue, receivedAt, oldValue) {
  return { v: 1, type: "signal_write", t: 1.5, signal_id: signalId,
           old: oldValue, new: newValue, source: "external", receivedAt };
}

test("buildSignalsModel：订阅数来自 graph，runs 按 deps 关联到信号", () => {
  const rows = panel.buildSignalsModel(GRAPH, []);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 11112222);
  assert.equal(rows[0].shortId, "#2222");
  assert.equal(rows[0].subscribers, 2);
  assert.equal(rows[0].runs, 7); // effect#91 的 deps 含 11112222 → 取它的 runs
  assert.equal(rows[1].id, 33334444);
  assert.equal(rows[1].subscribers, 0);
  assert.equal(rows[1].runs, 3); // effect#92 的 deps 含 33334444
});

test("buildSignalsModel：signal_write 累计当前值/写入次数/最近写入时间", () => {
  const t1 = new Date(2026, 8, 15, 10, 20, 30).getTime();
  const t2 = new Date(2026, 8, 15, 10, 20, 31).getTime();
  const t3 = new Date(2026, 8, 15, 10, 20, 32).getTime();
  const rows = panel.buildSignalsModel(GRAPH, [
    write(11112222, 5, t1, 0),
    write(11112222, "hello", t2, 5),
    write(33334444, { x: 1 }, t3, null)
  ]);
  const sig1 = rows.find((r) => r.id === 11112222);
  assert.equal(sig1.writes, 2);
  assert.equal(sig1.value, "hello"); // 当前值 = 最近一次 new
  assert.equal(sig1.rawValue, "hello");
  assert.equal(sig1.lastWriteAt, t2);
  assert.equal(sig1.lastWriteLabel, "10:20:31");

  const sig2 = rows.find((r) => r.id === 33334444);
  assert.equal(sig2.writes, 1);
  assert.equal(sig2.value, '{"x":1}'); // 对象 JSON 预览
  assert.equal(sig2.lastWriteLabel, "10:20:32");
});

test("buildSignalsModel：仅出现在写入流的信号补列，graph 缺字段宽容", () => {
  const rows = panel.buildSignalsModel(GRAPH, [write(55556666, 9, 1726300000000, 8)]);
  const sig3 = rows.find((r) => r.id === 55556666);
  assert.ok(sig3); // graph 里没有也入表
  assert.equal(sig3.subscribers, null); // DOM 显示 "–"
  assert.equal(sig3.runs, null);
  assert.equal(sig3.writes, 1);
  assert.equal(sig3.value, "9");

  assert.deepEqual(plain(panel.buildSignalsModel(null, [])), []);
  assert.deepEqual(plain(panel.buildSignalsModel({}, [])), []);
  assert.deepEqual(plain(panel.buildSignalsModel({ v: 1, type: "graph" }, null)), []);
});

test("buildSignalsModel：disposed effect 不参与 runs 关联", () => {
  const graph = {
    v: 1, type: "graph",
    signals: [{ id: 11112222, subscribers: 1 }],
    effects: [{ id: 91, deps: [11112222], runs: 7, disposed: true }]
  };
  const rows = panel.buildSignalsModel(graph, []);
  assert.equal(rows[0].runs, null); // 唯一依赖者已 disposed → 不取它的 runs
});

test("changedRowKeys：值/次数/runs 变化检出，首帧不闪", () => {
  const t = new Date(2026, 8, 15, 10, 20, 30).getTime();
  const first = panel.buildSignalsModel(GRAPH, []);
  assert.deepEqual(plain(panel.changedRowKeys([], first)), []); // 首帧全闪无意义
  assert.deepEqual(plain(panel.changedRowKeys(null, first)), []);

  const afterWrite = panel.buildSignalsModel(GRAPH, [write(11112222, 5, t, 0)]);
  assert.deepEqual(plain(panel.changedRowKeys(first, afterWrite)), ["11112222"]);

  const graph2 = JSON.parse(JSON.stringify(GRAPH));
  graph2.effects[0].runs = 8;
  const afterRuns = panel.buildSignalsModel(graph2, [write(11112222, 5, t, 0)]);
  assert.deepEqual(plain(panel.changedRowKeys(afterWrite, afterRuns)), ["11112222"]); // runs 变化也闪

  const same = panel.buildSignalsModel(graph2, [write(11112222, 5, t, 0)]);
  assert.deepEqual(plain(panel.changedRowKeys(afterRuns, same)), []); // 无变化不闪
});

// ── renderTreeLines ───────────────────────────────────────

const TREE = {
  v: 1, type: "tree",
  node_id: 99990001, component: "Shell", reuse_key: null,
  children: [
    { node_id: 99990002, component: "Counter", reuse_key: "row:3", children: [
      { node_id: 99990003, component: "Label", children: [] }
    ] },
    { node_id: 99990004, component: "Footer", children: [] } // 缺 reuse_key / children 键也宽容
  ]
};

test("renderTreeLines：嵌套 children 展开为缩进行，component #短号 + reuse_key", () => {
  const lines = panel.renderTreeLines(TREE);
  assert.equal(lines.length, 4);
  assert.deepEqual(
    plain(lines.map((l) => [l.depth, l.label])),
    [
      [0, "Shell #0001"],
      [1, "Counter #0002 · row:3"],
      [2, "Label #0003"],
      [1, "Footer #0004"]
    ]
  );
  assert.equal(lines[1].nodeId, 99990002);
  assert.equal(lines[1].reuseKey, "row:3");
  assert.equal(lines[0].reuseKey, null);
});

test("renderTreeLines：畸形输入宽容（nil / 缺字段 / 坏 child 跳过）", () => {
  assert.deepEqual(plain(panel.renderTreeLines(null)), []);
  assert.deepEqual(plain(panel.renderTreeLines({ v: 1 })), []); // 无 node_id 不入树
  const rows = panel.renderTreeLines({
    node_id: 1, component: "A",
    children: [null, { component: "no-id" }, { node_id: 2, component: "B" }]
  });
  assert.deepEqual(plain(rows.map((l) => l.label)), ["A #1", "B #2"]);
});

// ── panel.html 静态契约 ───────────────────────────────────

test("panel.html：标题栏 / 标签页 / .flash / token / 引用 /panel.js", () => {
  assert.match(PANEL_HTML, /Citrine DevTools · v1/); // 顶部标题
  assert.match(PANEL_HTML, /组件树/);
  assert.match(PANEL_HTML, /信号列表/);
  assert.match(PANEL_HTML, /<script src="\/panel\.js"><\/script>/); // 中继路由 GET /panel.js
  assert.match(PANEL_HTML, /\.flash/);
  assert.match(PANEL_HTML, /animation: flash \.6s/); // 0.6s 闪烁
  for (const token of ["--bg: #0b0e14", "--panel: #11151f", "--line: #232b3b",
                       "--fg: #c9d4e6", "--dim: #7d8aa5", "--accent: #4f8cff"]) {
    assert.ok(PANEL_HTML.includes(token), `缺 token ${token}`);
  }
  assert.match(PANEL_HTML, /font: 12px/); // 等宽 11-12px
});
