# citrine-devtools

Citrine/Emerald DevTools 传输层：中继服务 + 浏览器桥接脚本 + Web 调试面板。

信号式 Ruby UI 框架（[citrine](https://github.com/ShiningRay/citrine) /
[emerald](https://github.com/ShiningRay/emerald)）的调试器底座——把 M1 时序探针
（`write_log` / `flush_trace` / `event_stream` / `component_tree`）的数据经消息
总线送达调试面板，并把面板指令（`set_signal` / `force_rerun` / `request_tree` /
`request_graph`）转发回被调试页执行。协议契约见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。

## 组成

| 组件 | 说明 |
|---|---|
| `citrine-devtools serve` | 中继服务（默认 9527）：SSE 下行 + ingest/cmd 上行 + 静态托管面板与桥接脚本 |
| `bridge.js` | 被调试页引入的桥接脚本：采集探针 ring、上报、执行面板指令 |
| `panel.html` / `panel.js` | Web 调试面板：组件树 / 信号列表 / 依赖图（Cytoscape）/ Timeline / Inspector |

## 快速开始

```bash
gem install citrine-devtools
citrine-devtools serve          # → http://localhost:9527/ 打开面板

# 被调试页（由 citrine dev server 服务时）加一行：
<script src="http://127.0.0.1:9527/bridge.js"></script>
```

## 开发

```bash
bundle install && bundle exec rake   # Ruby 集成测试 + bridge 契约 + 面板模型契约
node --test                          # JS 契约（node 24+）
```

## 设计文档

分层架构、红线与路线图见 citrine 仓的
[DESIGN-devtools.md](https://github.com/ShiningRay/citrine/blob/main/docs/DESIGN-devtools.md) 与
[PLAN-devtools.md](https://github.com/ShiningRay/citrine/blob/main/docs/PLAN-devtools.md)。

## License

MIT（含 vendor 的 Cytoscape.js，MIT © The Cytoscape Consortium）。
