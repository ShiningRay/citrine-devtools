/*
 * citrine-devtools 面板（M3 骨架 / M4 依赖图）——中继托管的独立 Web 面板，无构建 vanilla JS。
 * 数据流（docs/PROTOCOL.md v1）：
 *   下行 EventSource /__devtools/stream 消费 tree / graph / signal_write；
 *   上行 POST /__devtools/cmd 发 request_tree / request_graph。
 *
 * 结构（协作契约）：
 *   上半部是纯函数视图模型（不依赖 window/document，经 vm 沙箱加载本文件的
 *   module.exports 分支做单测）；DOM/cytoscape 绑定只在浏览器分支执行。
 */
(function () {
  "use strict";

  var PROTOCOL_VERSION = 1;
  var VALUE_PREVIEW_LIMIT = 40; // 信号值预览截断（write_log 已在探针侧截 200 字符）
  var WRITE_LOG_LIMIT = 1000; // 面板侧写入流缓存上限（旧条目丢弃）

  // ── 纯函数：消息校验（v 不符 / 非 JSON 一律忽略，协议口径）────────

  function isValidMessage(message) {
    return !!message && typeof message === "object" &&
           message.v === PROTOCOL_VERSION && typeof message.type === "string";
  }

  // SSE data: 行 → 消息对象；解析失败或 v 不符返回 null
  function parseSSEData(data) {
    var message;
    try {
      message = JSON.parse(data);
    } catch (err) {
      return null; // 非 JSON 包一律忽略
    }
    return isValidMessage(message) ? message : null;
  }

  // ── 纯函数：显示辅助 ─────────────────────────────────────────

  // object_id 短号：末四位（信号表 sig 列、组件树 #node_id 共用）
  function shortId(id) {
    if (id === null || id === undefined) return "#----";
    return "#" + String(id).slice(-4);
  }

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  // epoch 毫秒 → HH:MM:SS（本地时）
  function formatClock(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "--:--:--";
    var d = new Date(ms);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  // 信号值预览：字符串原样（截断），对象 JSON（截断），nil 占位
  function formatValue(value) {
    if (value === null || value === undefined) return "nil";
    if (typeof value === "string") {
      return value.length > VALUE_PREVIEW_LIMIT ? value.slice(0, VALUE_PREVIEW_LIMIT) + "…" : value;
    }
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    var text;
    try {
      text = JSON.stringify(value);
    } catch (err) {
      text = String(value);
    }
    if (text === undefined) text = String(value);
    return text.length > VALUE_PREVIEW_LIMIT ? text.slice(0, VALUE_PREVIEW_LIMIT) + "…" : text;
  }

  // ── 纯函数：信号表视图模型 ────────────────────────────────────
  //
  // graph 消息：{v, type:"graph", signals:[{id, subscribers}], effects:[{id, deps, runs, disposed}]}
  // writeEntries：signal_write 消息流（DOM 层补记 receivedAt=收到时的 epoch 毫秒；
  //   探针 t 为单调时钟秒，仅作 receivedAt 缺失时的回退）。
  // runs 口径（契约）：某 effect 的 deps 含该信号 id，则该信号 runs 取这个 effect 的
  //   runs——取第一个命中的 effect；disposed 的 effect 不参与（依赖图快照本已剔除）。
  function buildSignalsModel(graphMsg, writeEntries) {
    var signals = graphMsg && Array.isArray(graphMsg.signals) ? graphMsg.signals : [];
    var effects = graphMsg && Array.isArray(graphMsg.effects) ? graphMsg.effects : [];
    var writes = Array.isArray(writeEntries) ? writeEntries : [];

    var rows = [];
    var byId = new Map(); // String(id) → row，graph 顺序在前、仅写入流出现的在后
    function rowFor(id) {
      var key = String(id);
      var row = byId.get(key);
      if (!row) {
        row = {
          id: id,
          shortId: shortId(id),
          value: "nil",       // 当前值 = 最近一次写入的 new
          rawValue: undefined,
          writes: 0,          // 写入次数
          lastWriteAt: null,  // 最近写入 epoch 毫秒（闪烁/排序用）
          lastWriteLabel: "--:--:--",
          subscribers: null,  // 订阅数（graph 未报 → null，DOM 显示 "–"）
          runs: null          // runs（无依赖该信号的 effect → null）
        };
        byId.set(key, row);
        rows.push(row);
      }
      return row;
    }

    signals.forEach(function (sig) {
      if (!sig || sig.id === null || sig.id === undefined) return;
      var row = rowFor(sig.id);
      row.subscribers = typeof sig.subscribers === "number" ? sig.subscribers : null;
    });

    rows.forEach(function (row) {
      var key = String(row.id);
      for (var i = 0; i < effects.length; i++) {
        var eff = effects[i];
        if (!eff || eff.disposed === true || !Array.isArray(eff.deps)) continue;
        var hit = false;
        for (var j = 0; j < eff.deps.length; j++) {
          if (String(eff.deps[j]) === key) { hit = true; break; }
        }
        if (hit) {
          row.runs = typeof eff.runs === "number" ? eff.runs : 0;
          break; // 第一个命中即取（契约）
        }
      }
    });

    writes.forEach(function (entry) {
      if (!entry || entry.signal_id === null || entry.signal_id === undefined) return;
      var row = rowFor(entry.signal_id);
      row.writes += 1;
      row.rawValue = entry.new;
      row.value = formatValue(entry.new);
      var ms = null;
      if (typeof entry.receivedAt === "number") ms = entry.receivedAt;
      else if (typeof entry.t === "number" && isFinite(entry.t) && entry.t > 1e9) ms = entry.t * 1000;
      if (ms !== null) {
        row.lastWriteAt = ms;
        row.lastWriteLabel = formatClock(ms);
      }
    });

    return rows;
  }

  // 值/次数/订阅/runs 有变化的行（String(id) 列表）——首帧不闪（全"变化"无意义）
  function changedRowKeys(prevRows, nextRows) {
    if (!prevRows || !prevRows.length || !nextRows) return [];
    var prev = new Map();
    prevRows.forEach(function (r) { prev.set(String(r.id), r); });
    return nextRows.filter(function (r) {
      var p = prev.get(String(r.id));
      if (!p) return true; // 新出现的信号
      return p.value !== r.value || p.writes !== r.writes ||
             p.runs !== r.runs || p.subscribers !== r.subscribers;
    }).map(function (r) { return String(r.id); });
  }

  // ── 纯函数：组件树 → 缩进行 ───────────────────────────────────
  //
  // tree 消息（Citrine.debug_component_tree 快照）：根条目
  //   {node_id, component, reuse_key, children:[…]}（children 嵌套同形）。
  // 输出扁平行 [{depth, label, nodeId, reuseKey}]，DOM 按 depth 缩进渲染。
  function renderTreeLines(treeMsg) {
    var lines = [];
    if (!treeMsg || typeof treeMsg !== "object") return lines;
    function walk(node, depth) {
      if (!node || typeof node !== "object") return;
      if (node.node_id === null || node.node_id === undefined) return; // 缺锚点不入树
      var label = (node.component !== null && node.component !== undefined
                   ? String(node.component) : "(component)") + " " + shortId(node.node_id);
      if (node.reuse_key !== null && node.reuse_key !== undefined) {
        label += " · " + String(node.reuse_key);
      }
      lines.push({
        depth: depth,
        label: label,
        nodeId: node.node_id,
        reuseKey: node.reuse_key !== null && node.reuse_key !== undefined
                  ? String(node.reuse_key) : null
      });
      var children = Array.isArray(node.children) ? node.children : [];
      for (var i = 0; i < children.length; i++) walk(children[i], depth + 1);
    }
    walk(treeMsg, 0);
    return lines;
  }

  // ── 纯函数：依赖图视图模型（M4，Cytoscape elements）──────────
  //
  // graph 消息：{v, type:"graph", signals:[{id, subscribers}], effects:[{id, deps, runs, disposed}]}
  // writeCounts：signal_write 流的面板侧累计（String(signal_id) → 次数，Map 或普通对象），
  //   即 Signals 表"写入次数"的同源数据（那边由 buildSignalsModel 数 writeLog 得出）。
  // 输出 Cytoscape elements 数组：signal 节点 id 前缀 "s"、data 带 subscribers/writes；
  // effect 节点前缀 "e"、label 带 runs（fx短号 ×runs）；边 signal→effect 来自 effect.deps，
  // data.id = "s:<sig>|e:<fx>"（边箭头在样式层画在 target=effect 端）。
  // 宽容口径：dep id 在 signals 里无对应 → 跳过该边（孤儿引用）；disposed effect 整棵剔除。

  // cytoscape 加载失败（vendor 脚本 404/被拦）时容器内的降级文案
  var GRAPH_FALLBACK_TEXT = "依赖图不可用：cytoscape.js 未加载（请确认中继已升级 M4+，且 GET /vendor/cytoscape.min.js 可访问）";

  var HEAT_BASE = "#33415c";   // 0 写入：灰蓝基础色
  var HEAT_ACCENT = "#4f8cff"; // max 写入：高亮 accent（--accent token 同源）

  // writeCounts 取值：Map / 普通对象都收（String(id) 键），非法值按 0
  function countOf(writeCounts, id) {
    if (!writeCounts) return 0;
    var value;
    if (typeof writeCounts.get === "function") {
      value = writeCounts.get(String(id));
    } else {
      value = writeCounts[String(id)];
    }
    return typeof value === "number" && isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  function buildGraphModel(graphMsg, writeCounts) {
    var signals = graphMsg && Array.isArray(graphMsg.signals) ? graphMsg.signals : [];
    var effects = graphMsg && Array.isArray(graphMsg.effects) ? graphMsg.effects : [];
    var elements = [];
    var signalIds = new Map(); // String(id) → true（边的孤儿判定 + 信号去重）
    var seenEffects = new Map(); // String(id) → true（重复 effect 去重）

    signals.forEach(function (sig) {
      if (!sig || sig.id === null || sig.id === undefined) return;
      var key = String(sig.id);
      if (signalIds.has(key)) return;
      signalIds.set(key, true);
      elements.push({
        group: "nodes",
        data: {
          id: "s:" + key,
          label: shortId(sig.id),
          kind: "signal",
          sid: sig.id,
          subscribers: typeof sig.subscribers === "number" ? sig.subscribers : 0,
          writes: countOf(writeCounts, sig.id)
        }
      });
    });

    effects.forEach(function (eff) {
      if (!eff || eff.id === null || eff.id === undefined) return;
      if (eff.disposed === true) return; // disposed 不入图（节点与边一并剔除）
      var ekey = String(eff.id);
      if (seenEffects.has(ekey)) return;
      seenEffects.set(ekey, true);
      var runs = typeof eff.runs === "number" && isFinite(eff.runs) ? eff.runs : 0;
      elements.push({
        group: "nodes",
        data: {
          id: "e:" + ekey,
          label: "fx" + shortId(eff.id) + " ×" + runs,
          kind: "effect",
          eid: eff.id,
          runs: runs
        }
      });
      var deps = Array.isArray(eff.deps) ? eff.deps : [];
      deps.forEach(function (dep) {
        if (dep === null || dep === undefined) return;
        var dkey = String(dep);
        if (!signalIds.has(dkey)) return; // 孤儿 dep：graph 信号表无此 id，跳过
        var edgeId = "s:" + dkey + "|e:" + ekey;
        for (var i = 0; i < elements.length; i++) {
          if (elements[i].group === "edges" && elements[i].data.id === edgeId) return; // 同 effect 重复 dep 去重
        }
        elements.push({
          group: "edges",
          data: { id: edgeId, source: "s:" + dkey, target: "e:" + ekey }
        });
      });
    });

    return elements;
  }

  // heat：0 写入 → 灰蓝基础色，max 写入 → 高亮 accent，线性 RGB 插值（超出 max 钳到 accent）
  function heatColor(writeCount, max) {
    var ratio = 0;
    if (typeof max === "number" && isFinite(max) && max > 0 &&
        typeof writeCount === "number" && isFinite(writeCount) && writeCount > 0) {
      ratio = Math.min(writeCount, max) / max;
    }
    var out = "#";
    for (var i = 0; i < 3; i++) {
      var a = parseInt(HEAT_BASE.slice(1 + i * 2, 3 + i * 2), 16);
      var b = parseInt(HEAT_ACCENT.slice(1 + i * 2, 3 + i * 2), 16);
      var v = Math.round(a + (b - a) * ratio);
      out += (v < 16 ? "0" : "") + v.toString(16);
    }
    return out;
  }

  // 结构哈希源：节点/边数量 + 节点 id + 边端点 + 各 effect 的 runs。
  // 故意不含 writes（heat 数据源）——heat 变了签名不变，只刷样式；runs/结构变了才重建。
  function graphSignature(model) {
    var nodes = [];
    var edges = [];
    (Array.isArray(model) ? model : []).forEach(function (elv) {
      if (!elv || !elv.data) return;
      if (elv.group === "edges") {
        edges.push(elv.data.source + ">" + elv.data.target);
      } else {
        nodes.push(elv.data.id + "=" + (elv.data.kind === "effect" ? elv.data.runs : ""));
      }
    });
    return "n" + nodes.length + ".e" + edges.length + ":" + nodes.join(",") + ";" + edges.join(",");
  }

  // 模型里 signal 节点 writes 的最大值（heat 归一化分母；无写入 → 0，heatColor 退化基础色）
  function maxWritesOf(model) {
    var max = 0;
    (Array.isArray(model) ? model : []).forEach(function (elv) {
      if (elv && elv.group === "nodes" && elv.data &&
          typeof elv.data.writes === "number" && elv.data.writes > max) {
        max = elv.data.writes;
      }
    });
    return max;
  }

  // 给模型节点填 data.heat（cytoscape 样式用 "background-color": "data(heat)" 映射）
  function applyHeatColors(model, max) {
    (Array.isArray(model) ? model : []).forEach(function (elv) {
      if (elv && elv.group === "nodes" && elv.data) {
        elv.data.heat = heatColor(elv.data.writes, max);
      }
    });
    return model;
  }

  // ── 纯函数：Timeline 视图模型（M4，纵向时间轴）───────────────
  //
  // 数据源是既有 SSE 流：event（flush_ids 关联）/ flush（effects 耗时）/ signal_write。
  // 时间戳沿用 M3 口径：receivedAt（面板收到时的墙钟）优先，探针单调时钟 t（秒）回退，再退 now。
  // 泳道：event → "事件"，flush → "flush"，signal_write → 短号泳道；写入流里前
  // TIMELINE_LANE_LIMIT 个不同信号各占一泳道，超出/缺失归「其他信号」。

  var TIMELINE_LANE_LIMIT = 8;

  // flush 总耗时 = effects[].duration_ms 求和（缺字段/裸 id 条目按 0 计，宽容）
  function flushTotalMs(effects) {
    var total = 0;
    (Array.isArray(effects) ? effects : []).forEach(function (eff) {
      if (eff && typeof eff === "object" &&
          typeof eff.duration_ms === "number" && isFinite(eff.duration_ms)) {
        total += eff.duration_ms;
      }
    });
    return total;
  }

  // 泳道归类：event/flush 固定泳道（kind 或 type 字段都认），signal_write 查映射，无命中归「其他信号」
  function laneOf(entry, signalLanes) {
    if (!entry || typeof entry !== "object") return "其他信号";
    var kind = entry.kind || entry.type;
    if (kind === "event") return "事件";
    if (kind === "flush") return "flush";
    if (entry.signal_id === null || entry.signal_id === undefined) return "其他信号";
    var key = String(entry.signal_id);
    if (signalLanes && typeof signalLanes.has === "function" && signalLanes.has(key)) {
      return signalLanes.get(key);
    }
    return "其他信号";
  }

  // 时间戳口径：receivedAt → t（单调时钟秒，>1e9 才认）→ fallbackMs
  function entryTimeMs(entry, fallbackMs) {
    if (entry && typeof entry.receivedAt === "number" && isFinite(entry.receivedAt)) {
      return entry.receivedAt;
    }
    if (entry && typeof entry.t === "number" && isFinite(entry.t) && entry.t > 1e9) {
      return entry.t * 1000;
    }
    return typeof fallbackMs === "number" && isFinite(fallbackMs) ? fallbackMs : 0;
  }

  // HH:MM:SS.mmm（本地时）；非法输入兜底
  function formatTimelineTime(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "--:--:--.---";
    var d = new Date(ms);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()) +
           "." + ("00" + d.getMilliseconds()).slice(-3);
  }

  // 环形缓冲：丢弃最旧，保留最近 cap 条（M1 ring 口径）
  function trimBuffer(buf, cap) {
    if (!Array.isArray(buf)) return buf;
    var limit = typeof cap === "number" && isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
    if (limit > 0 && buf.length > limit) buf.splice(0, buf.length - limit);
    return buf;
  }

  // 三路缓冲 → 行模型（最新在上）：{id, time, lane, label, kind, links}
  // links 仅 event 行有：其 flush_ids 对应的 flush 行 id（"flush#<id>"），供关联高亮
  function buildTimelineRows(eventBuf, flushBuf, writeBuf, now) {
    var items = [];
    function collect(buf, kind) {
      (Array.isArray(buf) ? buf : []).forEach(function (entry, i) {
        if (!entry || typeof entry !== "object") return;
        items.push({
          entry: entry,
          kind: kind,
          seq: typeof entry.seq === "number" && isFinite(entry.seq) ? entry.seq : i
        });
      });
    }
    collect(eventBuf, "event");
    collect(flushBuf, "flush");
    collect(writeBuf, "signal_write");

    // 信号泳道映射：写入流前 8 个不同信号（出现顺序）各占一短号泳道
    var seenIds = [];
    (Array.isArray(writeBuf) ? writeBuf : []).forEach(function (entry) {
      if (!entry || entry.signal_id === null || entry.signal_id === undefined) return;
      var key = String(entry.signal_id);
      if (seenIds.indexOf(key) === -1) seenIds.push(key);
    });
    var signalLanes = new Map();
    seenIds.slice(0, TIMELINE_LANE_LIMIT).forEach(function (key) {
      for (var i = 0; i < (Array.isArray(writeBuf) ? writeBuf.length : 0); i++) {
        var entry = writeBuf[i];
        if (entry && String(entry.signal_id) === key) {
          signalLanes.set(key, shortId(entry.signal_id));
          break;
        }
      }
    });

    items.sort(function (a, b) {
      return entryTimeMs(b.entry, now) - entryTimeMs(a.entry, now) || b.seq - a.seq;
    });

    return items.map(function (item, index) {
      var e = item.entry;
      var time = entryTimeMs(e, now);
      if (item.kind === "event") {
        var label = String(e.event_type !== null && e.event_type !== undefined ? e.event_type : "event") +
                    " @" + String(e.target_component !== null && e.target_component !== undefined
                                   ? e.target_component : "?");
        if (e.handler_name !== null && e.handler_name !== undefined) {
          label += " · " + String(e.handler_name);
        }
        return {
          id: "event#" + index,
          time: time,
          lane: laneOf(e),
          kind: "event",
          label: label,
          links: (Array.isArray(e.flush_ids) ? e.flush_ids : []).map(function (fid) {
            return "flush#" + fid;
          })
        };
      }
      if (item.kind === "flush") {
        var effects = Array.isArray(e.effects) ? e.effects : [];
        return {
          id: "flush#" + (e.flush_id !== null && e.flush_id !== undefined ? e.flush_id : index),
          time: time,
          lane: laneOf(e),
          kind: "flush",
          label: effects.length + " fx · " + flushTotalMs(effects) + "ms",
          links: []
        };
      }
      return {
        id: "write#" + index,
        time: time,
        lane: laneOf(e, signalLanes),
        kind: "signal_write",
        label: formatValue(e.old) + " → " + formatValue(e.new),
        links: []
      };
    });
  }

  // ── 纯函数：Inspector 信号改值（M4）────────────────────────
  //
  // 输入框宽松解析：JSON 优先（数字/布尔/null/引号串/对象/数组），失败退数字字面量，
  // 再退原样 string。signal_id/effect_id 发 cmd 时须为数字（bridge 按 object_id === 严格比）。
  function parseLooseValue(text) {
    if (typeof text !== "string") return text === undefined || text === null ? "" : text;
    var trimmed = text.trim();
    if (trimmed === "") return "";
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
      return text; // 其余原样 string
    }
  }

  // 选中信号的第一个依赖 effect（graph 里 deps 含该 signal 且未 disposed）→ effect_id 或 null
  function inspectorEffectFor(graphMsg, signalId) {
    var effects = graphMsg && Array.isArray(graphMsg.effects) ? graphMsg.effects : [];
    var key = String(signalId);
    for (var i = 0; i < effects.length; i++) {
      var eff = effects[i];
      if (!eff || eff.id === null || eff.id === undefined || eff.disposed === true) continue;
      var deps = Array.isArray(eff.deps) ? eff.deps : [];
      for (var j = 0; j < deps.length; j++) {
        if (String(deps[j]) === key) return eff.id;
      }
    }
    return null;
  }

  // 写值回执判定：awaiting（窗内未到）/ confirmed（窗内收到同信号写入）/ timeout（超窗/迟达）
  function receiptState(sentAt, echoAt, nowMs, windowMs) {
    var win = typeof windowMs === "number" && windowMs > 0 ? windowMs : 2000;
    if (typeof echoAt === "number" && isFinite(echoAt) && echoAt >= sentAt) {
      return echoAt - sentAt <= win ? "confirmed" : "timeout";
    }
    if (typeof nowMs !== "number" || !isFinite(nowMs) || nowMs - sentAt < win) return "awaiting";
    return "timeout";
  }

  // ── node 测试入口（契约：纯函数挂 module.exports 分支）────────
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      PROTOCOL_VERSION: PROTOCOL_VERSION,
      isValidMessage: isValidMessage,
      parseSSEData: parseSSEData,
      shortId: shortId,
      formatClock: formatClock,
      formatValue: formatValue,
      buildSignalsModel: buildSignalsModel,
      changedRowKeys: changedRowKeys,
      renderTreeLines: renderTreeLines,
      GRAPH_FALLBACK_TEXT: GRAPH_FALLBACK_TEXT,
      HEAT_BASE: HEAT_BASE,
      HEAT_ACCENT: HEAT_ACCENT,
      countOf: countOf,
      buildGraphModel: buildGraphModel,
      heatColor: heatColor,
      graphSignature: graphSignature,
      maxWritesOf: maxWritesOf,
      applyHeatColors: applyHeatColors,
      TIMELINE_LANE_LIMIT: TIMELINE_LANE_LIMIT,
      flushTotalMs: flushTotalMs,
      laneOf: laneOf,
      entryTimeMs: entryTimeMs,
      formatTimelineTime: formatTimelineTime,
      trimBuffer: trimBuffer,
      buildTimelineRows: buildTimelineRows,
      parseLooseValue: parseLooseValue,
      inspectorEffectFor: inspectorEffectFor,
      receiptState: receiptState
    };
    return; // node 环境到此为止，下面是浏览器 DOM 绑定
  }

  // ── 浏览器：DOM 绑定 ─────────────────────────────────────────

  if (typeof document === "undefined") return;

  var es = null;
  var writeLog = [];
  var writeCounts = new Map(); // String(signal_id) → 累计写入次数（依赖图 heat 数据源，与信号表同源不重复计数）
  var eventBuf = []; // Timeline：event 消息环形缓冲（seq = 到达序号，同毫秒时间戳的排序键）
  var flushBuf = []; // Timeline：flush 消息环形缓冲
  var arrivalSeq = 0;
  var linkedFlushes = {}; // Timeline：event 关联高亮的 flush 行 id 集（"flush#7" → true）
  var selectedKey = null; // Inspector：选中信号 String(id)；null = 未选中
  var pendingWrite = null; // Inspector：{signalId, sentAt} 等待 signal_write 回执
  var lastTreeMsg = null;
  var lastGraphMsg = null;
  var lastModel = [];
  var cy = null; // cytoscape 实例（切到依赖图页签才惰性初始化）
  var lastGraphSignature = null; // 上次渲染的图结构签名（签名同 → 只刷 heat，不同 → 重建）
  var activeTab = "tree";
  var everTree = false; // 组件树自动重发的前置：窗口已收到过 tree 消息

  var TIMELINE_CAP = 200; // Timeline 环形容量（与 M1 ring 口径一致：丢最旧留最新）
  var TIMELINE_RENDER_LIMIT = 100; // DOM 只渲染最近 100 行，防长会话膨胀
  var RECEIPT_WINDOW_MS = 2000; // 写值回执判定窗口

  function el(id) { return document.getElementById(id); }

  function postCmd(cmd, params) {
    var body = { v: PROTOCOL_VERSION, type: "cmd", cmd: cmd };
    if (params) {
      for (var key in params) {
        if (Object.prototype.hasOwnProperty.call(params, key)) body[key] = params[key];
      }
    }
    fetch("/__devtools/cmd", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).catch(function (err) {
      console.warn("[citrine-devtools] 指令发送失败:", err);
    });
  }

  // 打开与点刷新按钮时：两个快照都重新请求
  function requestAll() {
    postCmd("request_graph");
    postCmd("request_tree");
  }

  function setConnected(on) {
    el("dot").className = on ? "dot on" : "dot";
    el("status-text").textContent = on ? "已连接" : "未连接";
  }

  function connect() {
    es = new EventSource("/__devtools/stream");
    es.onopen = function () {
      setConnected(true); // 绿点（SSE 自动重连后也会触发，顺带重新请求快照）
      requestAll();
    };
    es.onerror = function () {
      setConnected(false); // 红点；EventSource 自动重连
    };
    es.onmessage = function (e) {
      var message = parseSSEData(e.data);
      if (!message) return;
      switch (message.type) {
        case "tree":
          lastTreeMsg = message;
          everTree = true;
          if (activeTab === "tree") renderTree();
          break;
        case "graph":
          lastGraphMsg = message; // 依赖图/信号表共享一份 graph 快照（runs/订阅数可能变）
          renderSignals();
          if (activeTab === "graph") renderGraph();
          break;
        case "signal_write":
          message.receivedAt = Date.now(); // 面板收到时刻 = 展示用的 wall clock
          writeLog.push(message);
          if (writeLog.length > WRITE_LOG_LIMIT) {
            writeLog.splice(0, writeLog.length - WRITE_LOG_LIMIT);
          }
          var wkey = String(message.signal_id);
          writeCounts.set(wkey, (writeCounts.get(wkey) || 0) + 1); // heat 累计（信号表的次数由 buildSignalsModel 数 writeLog 得出，不复用此值以免双口径）
          if (pendingWrite && wkey === pendingWrite.signalId &&
              receiptState(pendingWrite.sentAt, Date.now(), Date.now(), RECEIPT_WINDOW_MS) !== "timeout") {
            pendingWrite = null;
            setInspectorStatus("✓ 已生效", "ok");
          }
          renderSignals();
          if (activeTab === "graph") renderGraph();
          if (activeTab === "timeline") renderTimeline();
          break;
        case "event":
          message.receivedAt = Date.now();
          message.seq = arrivalSeq++;
          eventBuf.push(message);
          trimBuffer(eventBuf, TIMELINE_CAP);
          if (activeTab === "timeline") {
            perfMeasureEvent(message);
            renderTimeline();
          }
          break;
        case "flush":
          message.receivedAt = Date.now();
          message.seq = arrivalSeq++;
          flushBuf.push(message);
          trimBuffer(flushBuf, TIMELINE_CAP);
          if (activeTab === "timeline") {
            perfMeasureFlush(message);
            renderTimeline();
          }
          break;
        case "error":
          pendingWrite = null; // set_signal/force_rerun 失败不会有回执，直接展示错误
          setInspectorStatus(String(message.error || "未知错误"), "err");
          break;
        default:
          break; // cmd（面板自身指令广播）/ flush / event / error / hello：v1 面板不消费
      }
    };
  }

  function emptyNode(text, colspan) {
    var div = document.createElement("div");
    div.className = "empty";
    div.textContent = text;
    return div;
  }

  function renderTree() {
    var box = el("tree");
    box.textContent = "";
    if (!lastTreeMsg) {
      box.appendChild(emptyNode("等待 tree 消息…（被调试页需引入 bridge.js）"));
      return;
    }
    var lines = renderTreeLines(lastTreeMsg);
    if (!lines.length) {
      box.appendChild(emptyNode("tree 快照为空"));
      return;
    }
    lines.forEach(function (line) {
      var div = document.createElement("div");
      div.className = "tree-line";
      div.style.paddingLeft = (8 + line.depth * 14) + "px";
      div.textContent = line.label;
      box.appendChild(div);
    });
  }

  function safeString(value) {
    if (value === undefined) return "";
    if (value === null) return "nil";
    if (typeof value === "string") return value;
    try {
      var text = JSON.stringify(value);
      return text === undefined ? String(value) : text;
    } catch (err) {
      return String(value);
    }
  }

  function renderSignals() {
    var model = buildSignalsModel(lastGraphMsg, writeLog);
    var flashIds = changedRowKeys(lastModel, model);
    lastModel = model;
    if (activeTab !== "signals") return;
    var tbody = el("signals-body");
    tbody.textContent = "";
    if (!model.length) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.className = "empty";
      td.colSpan = 6;
      td.textContent = "等待 graph / signal_write 消息…";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    model.forEach(function (row) {
      var tr = document.createElement("tr");
      var classes = [];
      if (flashIds.indexOf(String(row.id)) !== -1) classes.push("flash");
      if (selectedKey === String(row.id)) classes.push("selected");
      if (classes.length) tr.className = classes.join(" ");
      tr.addEventListener("click", function () { toggleSelectSignal(row.id); });
      var cells = [
        row.shortId,
        row.value,
        String(row.writes),
        row.lastWriteLabel,
        row.subscribers === null ? "–" : String(row.subscribers),
        row.runs === null ? "–" : String(row.runs)
      ];
      cells.forEach(function (text, i) {
        var td = document.createElement("td");
        if (i === 1) {
          td.className = "val";
          td.title = safeString(row.rawValue); // 悬停看完整值
        }
        td.textContent = text;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    renderInspectorBar();
  }

  // ── 依赖图（M4）：cytoscape canvas 渲染，切到页签才惰性初始化 ──

  // heat 只经 data.heat 映射进样式；结构/数据变化经 updateCy 走签名比较
  function graphNodeStyles() {
    return [
      { selector: "node", style: {
        label: "data(label)",
        "font-size": 10,
        color: "#c9d4e6",
        "background-color": "data(heat)",
        width: 22,
        height: 22,
        "transition-property": "background-color opacity",
        "transition-duration": 0.3
      } },
      { selector: 'node[kind = "signal"]', style: { shape: "rectangle" } },
      { selector: 'node[kind = "effect"]', style: { shape: "ellipse" } },
      { selector: "edge", style: {
        width: 1.2,
        "line-color": "#3a4763",
        "target-arrow-shape": "triangle", // 箭头指向 target = effect
        "target-arrow-color": "#3a4763",
        "arrow-scale": 0.9,
        "curve-style": "bezier"
      } },
      { selector: ".dimmed", style: { opacity: 0.15 } }
    ];
  }

  function bindGraphTap() {
    cy.on("tap", "node", function (evt) {
      var neighborhood = evt.target.closedNeighborhood(); // 点击节点 + 邻居（经边相连）
      cy.elements().forEach(function (elv) {
        if (neighborhood.contains(elv)) elv.removeClass("dimmed");
        else elv.addClass("dimmed");
      });
    });
    cy.on("tap", function (evt) {
      if (evt.target === cy) cy.elements().removeClass("dimmed"); // 点空白恢复
    });
  }

  function initCy(model) {
    var box = el("graph");
    box.className = "";
    box.textContent = "";
    cy = window.cytoscape({
      container: box,
      elements: model,
      layout: { name: "cose", animate: false },
      style: graphNodeStyles()
    });
    lastGraphSignature = graphSignature(model);
    bindGraphTap();
  }

  // 签名同 → 结构未变（runs 也在签名里），只刷 heat 与 label/writes 等节点数据；
  // 签名不同 → cy.elements().remove() 全量重建并重跑 cose
  function updateCy(model) {
    var signature = graphSignature(model);
    if (signature === lastGraphSignature) {
      var byId = new Map();
      model.forEach(function (elv) {
        if (elv.group === "nodes") byId.set(elv.data.id, elv.data);
      });
      cy.nodes().forEach(function (node) {
        var data = byId.get(node.id());
        if (data) node.data(data); // data(heat) 映射自动重刷背景色
      });
      return;
    }
    lastGraphSignature = signature;
    cy.elements().remove();
    cy.add(model);
    cy.layout({ name: "cose", animate: false }).run();
  }

  function renderGraph() {
    if (activeTab !== "graph") return;
    var box = el("graph");
    if (typeof window.cytoscape === "undefined") { // vendor 库未加载 → 降级文案
      cy = null;
      lastGraphSignature = null;
      box.className = "empty";
      box.textContent = GRAPH_FALLBACK_TEXT;
      return;
    }
    if (!lastGraphMsg) {
      box.className = "empty";
      box.textContent = "等待 graph 消息…（被调试页需引入 bridge.js）";
      return;
    }
    var model = buildGraphModel(lastGraphMsg, writeCounts);
    applyHeatColors(model, maxWritesOf(model));
    if (!cy) initCy(model);
    else updateCy(model);
  }

  // ── Timeline（M4）：纵向时间轴 + performance.measure 集成 ────

  // DevTools Performance 面板集成：flush 作为耗时块（起始 = 收到时刻 - 总耗时），
  // event 作为零长 instant 标记。老内核/非 Chrome 无此 API 时静默跳过。
  function perfMeasureFlush(message) {
    if (typeof performance === "undefined" || !performance ||
        typeof performance.measure !== "function") return;
    try {
      var totalMs = flushTotalMs(message.effects);
      performance.measure("citrine flush#" + message.flush_id, {
        startTime: message.receivedAt - totalMs,
        duration: totalMs,
        detail: { trigger_signal_ids: message.trigger_signal_ids, effects: message.effects }
      });
    } catch (err) {
      /* 静默跳过 */
    }
  }

  function perfMeasureEvent(message) {
    if (typeof performance === "undefined" || !performance ||
        typeof performance.measure !== "function") return;
    try {
      performance.measure(
        "citrine event " + message.event_type + "@" + message.target_component,
        { startTime: message.receivedAt, duration: 0, detail: message }
      );
    } catch (err) {
      /* 静默跳过 */
    }
  }

  function timelineLaneClass(row) {
    if (row.kind === "event") return "tl-chip-event";
    if (row.kind === "flush") return "tl-chip-flush";
    return row.lane === "其他信号" ? "tl-chip-other" : "tl-chip-signal";
  }

  // 点击 event 行：其 links 全部已高亮 → 取消；否则整组高亮（再点取消）
  function toggleEventLinks(links) {
    return function () {
      var allLinked = links.every(function (id) { return linkedFlushes[id]; });
      links.forEach(function (id) {
        if (allLinked) delete linkedFlushes[id];
        else linkedFlushes[id] = true;
      });
      renderTimeline();
    };
  }

  function renderTimeline() {
    if (activeTab !== "timeline") return;
    var box = el("timeline");
    var rows = buildTimelineRows(eventBuf, flushBuf, writeLog.slice(-TIMELINE_CAP), Date.now());
    var view = rows.slice(0, TIMELINE_RENDER_LIMIT);
    var scrollTop = box.scrollTop; // 新行插在顶部，渲染后恢复滚动位置
    box.textContent = "";
    if (!view.length) {
      box.appendChild(emptyNode("等待 event / flush / signal_write 消息…"));
      return;
    }
    view.forEach(function (row) {
      var div = document.createElement("div");
      div.className = "tl-row tl-" + row.kind + (linkedFlushes[row.id] ? " linked" : "");
      var time = document.createElement("span");
      time.className = "tl-time";
      time.textContent = "[" + formatTimelineTime(row.time) + "]";
      var chip = document.createElement("span");
      chip.className = "tl-chip " + timelineLaneClass(row);
      chip.textContent = row.lane;
      var label = document.createElement("span");
      label.textContent = row.label;
      div.appendChild(time);
      div.appendChild(chip);
      div.appendChild(label);
      if (row.kind === "event" && row.links.length) {
        div.title = "点击高亮关联 flush：" + row.links.join(", ");
        div.addEventListener("click", toggleEventLinks(row.links));
      }
      box.appendChild(div);
    });
    box.scrollTop = scrollTop;
  }

  // ── Inspector（M4）：信号在线改值（挂在 Signals 表格上）──────

  function setInspectorStatus(text, kind) {
    var status = el("inspector-status");
    status.textContent = text;
    status.className = kind || "";
  }

  // bridge 按 object_id 严格比对（===）：数字外观的 id 发 number，其余原样
  function cmdId(key) {
    return /^-?\d+$/.test(key) ? Number(key) : key;
  }

  // 详情条动态区刷新（输入框/按钮只绑定一次，避免打字时被重渲染清掉）
  function renderInspectorBar() {
    var bar = el("inspector");
    if (!selectedKey) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    var row = null;
    for (var i = 0; i < lastModel.length; i++) {
      if (String(lastModel[i].id) === selectedKey) { row = lastModel[i]; break; }
    }
    el("inspector-sig").textContent = row ? row.shortId : "#" + selectedKey.slice(-4);
    var valueEl = el("inspector-value");
    valueEl.textContent = row ? "= " + row.value : "= ?";
    if (row) valueEl.title = safeString(row.rawValue);
    var effectId = inspectorEffectFor(lastGraphMsg, selectedKey);
    var rerunBtn = el("inspector-rerun");
    rerunBtn.disabled = effectId === null;
    rerunBtn.title = effectId === null
      ? "选中信号没有未 dispose 的依赖 effect"
      : "force_rerun fx#" + String(effectId).slice(-4);
    if (effectId === null && !pendingWrite) {
      setInspectorStatus("无依赖 effect，无法 force_rerun", "dim");
    }
  }

  function toggleSelectSignal(id) {
    var key = String(id);
    selectedKey = selectedKey === key ? null : key; // 再点取消选中
    pendingWrite = null;
    el("inspector-input").value = "";
    setInspectorStatus("", "");
    renderSignals();
    renderInspectorBar();
  }

  function bindInspector() {
    el("inspector-write").addEventListener("click", function () {
      if (!selectedKey) return;
      var value = parseLooseValue(el("inspector-input").value);
      var signalId = selectedKey;
      postCmd("set_signal", { signal_id: cmdId(signalId), value: value });
      pendingWrite = { signalId: signalId, sentAt: Date.now() };
      setInspectorStatus("等待回执…", "dim");
      setTimeout(function () { // 2s 无回执 → 超时复位
        if (pendingWrite && pendingWrite.signalId === signalId &&
            receiptState(pendingWrite.sentAt, null, Date.now(), RECEIPT_WINDOW_MS) === "timeout") {
          pendingWrite = null;
          setInspectorStatus("回执超时：未在 2s 内收到该信号的写入", "dim");
        }
      }, RECEIPT_WINDOW_MS);
    });
    el("inspector-rerun").addEventListener("click", function () {
      if (!selectedKey) return;
      var effectId = inspectorEffectFor(lastGraphMsg, selectedKey);
      if (effectId === null) return; // 按钮已禁用，双保险
      postCmd("force_rerun", { effect_id: cmdId(String(effectId)) });
      setInspectorStatus("force_rerun 已发送 fx#" + String(effectId).slice(-4), "dim");
    });
  }

  function switchTab(tab) {
    activeTab = tab;
    var tabs = document.querySelectorAll(".tab");
    Array.prototype.forEach.call(tabs, function (btn) {
      btn.className = btn.getAttribute("data-tab") === tab ? "tab active" : "tab";
    });
    el("view-tree").hidden = tab !== "tree";
    el("view-signals").hidden = tab !== "signals";
    el("view-graph").hidden = tab !== "graph";
    el("view-timeline").hidden = tab !== "timeline";
    if (tab === "tree") renderTree();
    else if (tab === "signals") renderSignals();
    else if (tab === "graph") {
      renderGraph();
      postCmd("request_graph"); // 打开依赖图即要一份最新快照
    }
    else if (tab === "timeline") renderTimeline();
  }

  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (btn) {
    btn.addEventListener("click", function () { switchTab(btn.getAttribute("data-tab")); });
  });
  el("refresh").addEventListener("click", requestAll);
  bindInspector();

  // 自动重发：组件树页签下 3s（窗口有 tree 消息时）；信号列表/依赖图页签下 5s（共享 graph 快照）
  setInterval(function () {
    if (activeTab === "tree" && everTree) postCmd("request_tree");
  }, 3000);
  setInterval(function () {
    if (activeTab === "signals" || activeTab === "graph") postCmd("request_graph");
  }, 5000);

  setConnected(false);
  renderTree();
  connect();
})();
