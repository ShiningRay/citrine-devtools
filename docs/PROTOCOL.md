# citrine-devtools · 传输协议 v1

> DESIGN-devtools §4 的落地契约。中继（`citrine-devtools serve`）是消息总线：
> 浏览器桥接脚本上报探针数据，调试面板订阅消费；面板指令经同一条总线下发桥接执行。
> 所有消息 JSON，顶层带 `v: 1` 与 `type`。

## 端点（默认端口 9527）

| 端点 | 方法 | 方向 | 说明 |
|---|---|---|---|
| `/__devtools/stream` | GET | 下行 | SSE 流。客户端两类：面板（消费数据+发指令）与桥接（收指令）。15s comment ping 清扫僵尸连接 |
| `/__devtools/ingest` | POST | 上行 | 桥接批量上报：`{v:1, messages:[…]}`。中继逐条广播给所有 stream 客户端 |
| `/__devtools/cmd` | POST | 上行 | 面板发指令：`{v:1, type:"cmd", cmd:"set_signal", …}`。中继原样广播（桥接消费、面板忽略） |
| `/bridge.js` | GET | — | 桥接脚本静态资源，`<script src="http://127.0.0.1:9527/bridge.js">` 引入被调试页 |

CORS：`Access-Control-Allow-Origin: *`（仅 localhost 调试场景），处理 OPTIONS 预检。

## 下行消息（v1）

| type | 载荷 | 生产者 |
|---|---|---|
| `hello` | `{v, app_name?, citrine_version?}` | 桥接连接时上报（幂等：Emerald 热更新重连可重复发） |
| `signal_write` | M1 write_log 条目 `{t, signal_id, old, new, source}` | 桥接 |
| `flush` | M1 flush_trace 条目 `{flush_id, t, effects, trigger_signal_ids}` | 桥接 |
| `event` | M1 event_stream 条目 `{t, event_type, target_component, handler_name, flush_ids}` | 桥接 |
| `tree` | `Citrine.debug_component_tree` 快照 | 桥接（应 `request_tree` 指令触发，也允许定时） |
| `graph` | `Citrine.debug_dependency_graph` 快照 | 桥接（应 `request_graph` 指令触发） |
| `cmd` | `{cmd, …参数}` 见下表 | 面板 → 中继广播 → 桥接执行 |

## 指令（cmd 载荷）

| cmd | 参数 | 桥接行为 |
|---|---|---|
| `set_signal` | `{signal_id, value}` | 在 `Signal.all` 里按 object_id 找信号并 `$set(value)`；找不到回 `error` |
| `force_rerun` | `{effect_id}` | 在 `Effect.all` 里按 object_id 找 effect 并 `$run` |
| `request_tree` / `request_graph` | `{}` | 采集快照以 `tree`/`graph` 消息回传 |
| `highlight_node` | `{node_id}` | v1 未实现：回 `{type:"error", error:"highlight_node 未实现（M3）"}` |

## 桥接脚本（bridge.js）行为契约

- 激活条件：`window.CITRINE_DEV && window.Opal`；否则静默不启动（生产/SSR 零影响）。
- 中继地址：`window.CITRINE_DEVTOOLS_URL` 覆盖，默认 `http://127.0.0.1:9527`。
- 采集：每 100ms 读 `Opal.Citrine` 的 write_log / flush_trace / event_stream 三个 ring
  （`$to_a().$to_n()`），与上次快照 diff（按条目去重，不假设 ring 不滚动），
  新条目攒批 POST ingest（另 50ms 聚合窗口）。
- 上报故障静默降级（warn 一次），绝不抛进被调试应用。
- 收到自身发不认识的 type 一律忽略；执行 cmd 的异常回 `{type:"error", cmd, error}`。

## 会话

v1 单会话：`hello` 的 `app_name` 仅作展示。多 Emerald 窗口同连一个中继时消息混合——
M5 前不按会话隔离（DESIGN §八 风险 5）。
