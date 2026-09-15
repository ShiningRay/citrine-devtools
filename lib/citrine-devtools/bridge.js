/*
 * citrine-devtools 桥接脚本（M2-2）——被调试页经
 * <script src="http://127.0.0.1:9527/bridge.js"> 引入。
 *
 * 行为契约见 citrine-devtools docs/PROTOCOL.md v1 §桥接脚本：
 *   - 激活条件 window.CITRINE_DEV && window.Opal；否则静默不启动（生产/SSR 零影响）
 *   - 中继地址 window.CITRINE_DEVTOOLS_URL 覆盖，默认 http://127.0.0.1:9527
 *   - 每 100ms 读三个 ring（write_log / flush_trace / event_stream，$to_a().$to_n()），
 *     按条目指纹去重 diff（不假设 ring 不滚动），新条目攒批 POST ingest
 *     （另 50ms 聚合窗口）
 *   - 上报故障静默降级（warn 一次），绝不抛进被调试应用
 *   - 收到自身发不认识的 type 一律忽略；执行 cmd 的异常回 {type:"error", cmd, error}
 *
 * request_tree 的根节点发现（本地实现细节，线上协议之外），按序尝试：
 *   1. window.CITRINE_DEVTOOLS_ROOT（页面可选提供：根 Node 或组件实例）
 *   2. 渲染器（Citrine.renderer）暴露的 root_node 方法（beryl 入口）
 *   3. 渲染器的 @root 实例变量（Canvas 渲染器有存）
 * 都找不到时回 error，由页面提供 CITRINE_DEVTOOLS_ROOT 解决。
 */
(function () {
  "use strict";

  if (typeof window === "undefined") return; // SSR：静默不启动
  // 激活条件（协议）：否则静默不启动
  if (!window.CITRINE_DEV || !window.Opal) return;
  // 同一页面二次求值不起第二个桥接实例（Emerald 热更新会重放脚本）
  if (window.__CITRINE_DEVTOOLS_BRIDGE__) return;
  window.__CITRINE_DEVTOOLS_BRIDGE__ = true;

  var Opal = window.Opal;
  var Citrine = Opal.Citrine;
  if (!Citrine) return;

  var PROTOCOL_VERSION = 1;
  var COLLECT_INTERVAL_MS = 100; // 协议：每 100ms 采集
  var FLUSH_WINDOW_MS = 50; // 协议：另 50ms 聚合窗口
  var SEEN_FINGERPRINTS_LIMIT = 2000; // ring 容量 500/个，去重指纹 FIFO 封顶（不假设 ring 不滚动）

  var relayUrl = String(window.CITRINE_DEVTOOLS_URL || "http://127.0.0.1:9527").replace(/\/+$/, "");

  // 探针只在 debug_tracking 开启时记录（M1 口径）：桥接是页面的调试代理，负责打开它
  try { Citrine["$debug_tracking="](true); } catch (e) { /* 旧版内核无开关则探针自管 */ }

  // ── 上行：攒批 POST ingest ─────────────────────────────

  var outbox = [];
  var flushTimer = null;
  var lastFlushAt = 0;
  var degraded = false; // 上报故障静默降级（warn 一次）

  function enqueue(message) {
    outbox.push(message);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    var wait = Math.max(0, FLUSH_WINDOW_MS - (Date.now() - lastFlushAt));
    flushTimer = setTimeout(flush, wait);
  }

  function flush() {
    flushTimer = null;
    if (!outbox.length) return;
    var batch = outbox;
    outbox = [];
    lastFlushAt = Date.now();
    fetch(relayUrl + "/__devtools/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: PROTOCOL_VERSION, messages: batch })
    }).then(function (res) {
      if (res && res.ok === false) throw new Error("HTTP " + res.status); // 非 2xx 也按上报失败降级
    }).catch(function (err) {
      if (!degraded) {
        degraded = true;
        console.warn("[citrine-devtools] 上报失败，桥接静默降级：", err);
      }
    });
  }

  function reportError(cmd, error) {
    enqueue({ v: PROTOCOL_VERSION, type: "error", cmd: cmd, error: String((error && error.message) || error) });
  }

  // ── 采集：三个 ring 的增量 diff ─────────────────────────

  var rings = [
    { type: "signal_write", read: function () { return Citrine.$debug_write_log().$to_a().$to_n(); } },
    { type: "flush", read: function () { return Citrine.$debug_flush_trace().$to_a().$to_n(); } },
    { type: "event", read: function () { return Citrine.$debug_event_stream().$to_a().$to_n(); } }
  ];
  var seen = new Map(); // 条目指纹 FIFO 集合：同一条目（ring 未滚动重读）只上报一次

  function fingerprint(entry) {
    try { return JSON.stringify(entry); } catch (e) { return String(entry); }
  }

  function markSeen(fp) {
    if (seen.has(fp)) return false;
    seen.set(fp, true);
    if (seen.size > SEEN_FINGERPRINTS_LIMIT) seen.delete(seen.keys().next().value);
    return true;
  }

  function collect() {
    rings.forEach(function (ring) {
      var entries;
      try {
        entries = ring.read();
      } catch (e) {
        return; // 探针读取失败不抛进被调试应用
      }
      if (!entries || !entries.length) return;
      entries.forEach(function (entry) {
        if (!entry || typeof entry !== "object") return;
        var fp = fingerprint(entry);
        if (!markSeen(fp)) return; // ring 未滚动时的重读 / 已上报条目
        var message = { v: PROTOCOL_VERSION, type: ring.type };
        for (var key in entry) message[key] = entry[key]; // 载荷即 M1 条目字段
        enqueue(message);
      });
    });
  }

  // ── 下行：SSE 收指令 ───────────────────────────────────

  var es = new EventSource(relayUrl + "/__devtools/stream");

  // 连接时上报 hello（幂等：热更新重连可重复发）；EventSource 自动重连
  es.onopen = function () {
    var hello = { v: PROTOCOL_VERSION, type: "hello", citrine_version: citrineVersion() };
    if (typeof document !== "undefined" && document.title) hello.app_name = document.title;
    enqueue(hello);
  };

  es.onmessage = function (e) {
    var message;
    try {
      message = JSON.parse(e.data);
    } catch (err) {
      return; // 非 JSON 包一律忽略
    }
    if (!message || message.v !== PROTOCOL_VERSION) return;
    // 畸形 cmd（缺 cmd 字段）按协议静默忽略；其余 type（含自身上报被广播回来的）一律忽略
    if (message.type === "cmd" && typeof message.cmd === "string") handleCmd(message);
  };

  function citrineVersion() {
    try { return Citrine.$const_get("VERSION"); } catch (e) { return undefined; }
  }

  function handleCmd(cmd) {
    try {
      switch (cmd.cmd) {
        case "set_signal": setSignal(cmd); break;
        case "force_rerun": forceRerun(cmd); break;
        case "request_tree": requestTree(cmd); break;
        case "request_graph": requestGraph(); break;
        case "highlight_node":
          reportError("highlight_node", "highlight_node 未实现（M3）");
          break;
        default:
          reportError(cmd.cmd, "未知指令: " + cmd.cmd);
      }
    } catch (err) {
      reportError(cmd.cmd, err); // 执行 cmd 的异常按协议回 error
    }
  }

  // JS 值 → Opal 值（跨语言边界）：null/undefined → Opal.nil，对象 → Opal.hash，数组递归，标量直通
  function jsToOpal(value) {
    if (value === null || value === undefined) return Opal.nil;
    if (Array.isArray(value)) {
      var list = [];
      for (var i = 0; i < value.length; i++) list.push(jsToOpal(value[i]));
      return list;
    }
    if (typeof value === "object") {
      var args = [];
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) args.push(key, jsToOpal(value[key]));
      }
      return Opal.hash.apply(null, args);
    }
    return value;
  }

  function setSignal(cmd) {
    var signal = findByObjectId(Citrine.Signal.$all(), cmd.signal_id);
    if (!signal) {
      reportError("set_signal", "找不到 signal（object_id=" + cmd.signal_id + "）");
      return;
    }
    signal.$set(jsToOpal(cmd.value));
  }

  function forceRerun(cmd) {
    var effect = findByObjectId(Citrine.Effect.$all(), cmd.effect_id);
    if (!effect) {
      reportError("force_rerun", "找不到 effect（object_id=" + cmd.effect_id + "）");
      return;
    }
    effect.$run();
  }

  // Opal 数组即 JS 数组，逐元素比 object_id（Signal.all / Effect.all 仅在埋点开启时填充，
  // 桥接启动时已打开 debug_tracking）
  function findByObjectId(all, id) {
    if (!all) return null;
    for (var i = 0; i < all.length; i++) {
      if (all[i] && all[i].$object_id() === id) return all[i];
    }
    return null;
  }

  function requestGraph() {
    var graph = Citrine.$debug_dependency_graph().$to_n(); // 打开埋点并取 {signals, effects}
    var message = { v: PROTOCOL_VERSION, type: "graph" };
    for (var key in graph) message[key] = graph[key];
    enqueue(message);
  }

  function requestTree(cmd) {
    var rootNode = findRootNode();
    if (!rootNode) {
      reportError("request_tree",
        "找不到渲染根节点：请在页面设置 window.CITRINE_DEVTOOLS_ROOT（根 Node 或组件实例）");
      return;
    }
    var snapshot = Citrine.$debug_component_tree(rootNode).$to_n();
    var message = { v: PROTOCOL_VERSION, type: "tree" };
    for (var key in snapshot) message[key] = snapshot[key];
    enqueue(message);
  }

  // 根节点发现顺序见文件头注释；组件（有 $root）与 Node（有 $children）都接受
  function findRootNode() {
    var provided = window.CITRINE_DEVTOOLS_ROOT;
    if (provided) {
      if (typeof provided.$children === "function") return provided; // 已是 Node
      if (typeof provided.$root === "function") return provided.$root(); // 组件实例
      return null;
    }
    try {
      var renderer = Citrine.$renderer();
      if (renderer) {
        // beryl 入口：渲染器暴露 root_node 方法（Opal 侧 respond_to? 判存在，判不到则鸭子类型）
        if (typeof renderer.$root_node === "function" &&
            (!renderer.$respond_to || renderer.$respond_to("root_node"))) {
          return renderer.$root_node();
        }
        // Canvas 渲染器：@root 实例变量
        var root = renderer.$instance_variable_get("@root");
        if (root) return root;
      }
    } catch (e) { /* 无渲染器或未挂载 */ }
    return null;
  }

  // ── 主循环 ────────────────────────────────────────────

  setInterval(collect, COLLECT_INTERVAL_MS);
})();
