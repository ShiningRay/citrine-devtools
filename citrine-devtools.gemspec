# frozen_string_literal: true

require_relative "lib/citrine-devtools/version"

Gem::Specification.new do |spec|
  spec.name = "citrine-devtools"
  spec.version = Citrine::DevTools::VERSION
  spec.authors = ["ShiningRay"]
  spec.email = ["shiningray@users.noreply.github.com"]

  spec.summary = "Citrine/Emerald DevTools 传输层：中继服务 + 浏览器桥接脚本"
  spec.description = "DevTools 消息总线：浏览器桥接脚本把 M1 探针时序数据" \
    "（write_log/flush_trace/event_stream）经 SSE 送达调试面板，并转发面板指令" \
    "（set_signal/force_rerun/request_tree/request_graph）回被调试页执行。" \
    "协议契约见 docs/PROTOCOL.md。"
  spec.homepage = "https://github.com/ShiningRay/citrine-devtools"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.0.0"

  spec.files = Dir["lib/**/*"] + %w[bin/citrine-devtools LICENSE README.md docs/PROTOCOL.md]
  spec.bindir = "bin"
  spec.executables = ["citrine-devtools"]
  spec.require_paths = ["lib"]

  # 中继服务运行时依赖（Rack + Puma，同 citrine DevServer 技术栈）
  spec.add_dependency "rack", ">= 3.0"
  spec.add_dependency "puma", ">= 6.0"

  spec.add_development_dependency "minitest"
  spec.add_development_dependency "rake"
end
