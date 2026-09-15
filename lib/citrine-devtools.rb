# frozen_string_literal: true

# citrine-devtools：Citrine/Emerald DevTools 的传输层（独立中继服务 + 浏览器桥接脚本）。
# 线上协议契约见 docs/PROTOCOL.md；本 gem 只含 CRuby/JS，可脱离 Opal 工具链测试。
require_relative "citrine-devtools/version"
require_relative "citrine-devtools/server"
