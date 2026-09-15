# frozen_string_literal: true

require_relative "test_helper"

# bridge.js 测试：语法检查 + 行为契约（node:test 套件 test/bridge_contract_test.mjs，
# vm 沙箱确定性驱动，与 package.json 的 npm test 同源）。
# node 不可用时跳过。
class BridgeJsTest < Minitest::Test
  BRIDGE_JS = File.expand_path("../lib/citrine-devtools/bridge.js", __dir__)
  CONTRACT_TEST = File.expand_path("bridge_contract_test.mjs", __dir__)

  def setup
    skip "node 不可用，跳过 bridge.js 测试" unless node_available?
  end

  def test_syntax_check
    assert system("node", "--check", BRIDGE_JS, out: File::NULL, err: File::NULL),
      "bridge.js 语法错误（node --check 失败）"
  end

  def test_behavior_contract
    assert system("node", "--test", CONTRACT_TEST),
      "bridge.js 行为契约测试失败（node --test test/bridge_contract_test.mjs 复现）"
  end

  private

  def node_available?
    system("node", "--version", out: File::NULL, err: File::NULL)
  end
end
