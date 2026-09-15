# frozen_string_literal: true

require_relative "test_helper"
require "citrine-devtools"

# M2-2 中继服务集成测试：随机高位端口（port 0），跑完关闭 server 与全部 SSE 连接。
class ServerTest < Minitest::Test
  Server = Citrine::DevTools::Server

  def with_server(**opts)
    server = Server.new(**{port: 0}.merge(opts)) # port 0：随机空闲端口，避免与运行中的中继（9527）冲突
    server.start
    yield server
  ensure
    server&.stop
  end

  def http(port, verb, path, body: nil, headers: {})
    uri = URI("http://127.0.0.1:#{port}#{path}")
    request = Net::HTTP.const_get(verb).new(uri)
    headers.each { |key, value| request[key] = value }
    request.body = body if body
    Net::HTTP.start(uri.host, uri.port, open_timeout: 5, read_timeout: 5) { |h| h.request(request) }
  end

  def post_json(port, path, body)
    http(port, :Post, path, body: body, headers: {"Content-Type" => "application/json"})
  end

  def wait_until(timeout = 5)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    until yield
      raise "wait_until 超时（#{timeout}s）" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

      sleep 0.05
    end
  end

  # ── /bridge.js 静态资源与 CORS ─────────────────────────

  def test_bridge_js_endpoint
    with_server do |server|
      res = http(server.port, :Get, "/bridge.js")
      assert_equal 200, res.code.to_i
      assert_match %r{\Aapplication/javascript}, res["content-type"].to_s
      assert_equal File.binread(Server::BRIDGE_JS_PATH), res.body
      assert_equal "*", res["access-control-allow-origin"]
    end
  end

  def test_cors_preflight_on_any_endpoint
    with_server do |server|
      res = http(server.port, :Options, "/__devtools/ingest")
      assert_equal 204, res.code.to_i
      assert_equal "*", res["access-control-allow-origin"]
      assert_includes res["access-control-allow-methods"], "POST"
      assert_includes res["access-control-allow-headers"], "content-type"
    end
  end

  # ── M3-1 面板静态托管 ─────────────────────────────────
  # 面板资产（panel.html / panel.js）由 M3-B 并行交付。中继口径：文件在则原样吐出，
  # 缺失（旧版安装）回 404 而非 500——文件就位后同一测试自动覆盖 200 + 内容一致分支。

  def test_root_serves_panel_html
    with_server do |server|
      res = http(server.port, :Get, "/")
      assert_equal "*", res["access-control-allow-origin"]
      if File.exist?(Server::PANEL_HTML_PATH)
        assert_equal 200, res.code.to_i
        assert_match %r{\Atext/html}, res["content-type"].to_s
        assert_equal File.binread(Server::PANEL_HTML_PATH), res.body
      else
        assert_equal 404, res.code.to_i
      end
    end
  end

  def test_panel_js_endpoint
    with_server do |server|
      res = http(server.port, :Get, "/panel.js")
      assert_equal "*", res["access-control-allow-origin"]
      if File.exist?(Server::PANEL_JS_PATH)
        assert_equal 200, res.code.to_i
        assert_match %r{\Aapplication/javascript}, res["content-type"].to_s
        assert_equal File.binread(Server::PANEL_JS_PATH), res.body
      else
        assert_equal 404, res.code.to_i
      end
    end
  end

  def test_panel_routes_reject_wrong_method
    with_server do |server|
      res = http(server.port, :Post, "/", body: "{}", headers: {"Content-Type" => "application/json"})
      assert_equal 405, res.code.to_i
      assert_equal "GET", res["allow"]

      res = http(server.port, :Post, "/panel.js", body: "{}", headers: {"Content-Type" => "application/json"})
      assert_equal 405, res.code.to_i
      assert_equal "GET", res["allow"]
    end
  end

  # ── M4 依赖图静态资源 ─────────────────────────────────

  def test_vendor_cytoscape_js_endpoint
    with_server do |server|
      res = http(server.port, :Get, "/vendor/cytoscape.min.js")
      assert_equal "*", res["access-control-allow-origin"]
      if File.exist?(Server::CYTOSCAPE_JS_PATH)
        assert_equal 200, res.code.to_i
        assert_match %r{\Aapplication/javascript}, res["content-type"].to_s
        assert_equal File.binread(Server::CYTOSCAPE_JS_PATH), res.body
      else
        assert_equal 404, res.code.to_i # 旧版安装缺文件：静态资源口径 404 而非 500
      end
    end
  end

  def test_vendor_cytoscape_js_rejects_wrong_method
    with_server do |server|
      res = http(server.port, :Post, "/vendor/cytoscape.min.js",
                 body: "{}", headers: {"Content-Type" => "application/json"})
      assert_equal 405, res.code.to_i
      assert_equal "GET", res["allow"]
    end
  end

  # ── SSE 下行 ──────────────────────────────────────────

  def test_stream_endpoint_headers
    with_server do |server|
      client = SseClient.new(server.port)
      assert_includes client.headers, "200 OK"
      assert_includes client.headers, "text/event-stream"
      assert_includes client.headers.downcase, "access-control-allow-origin: *"
    ensure
      client&.close
    end
  end

  def test_ingest_broadcasts_each_message_to_all_stream_clients
    with_server do |server|
      a = SseClient.new(server.port)
      b = SseClient.new(server.port)
      messages = [
        {v: 1, type: "hello", app_name: "demo"},
        {v: 1, type: "signal_write", t: 1, signal_id: 42, old: 0, new: 1, source: "external"},
        {v: 1, type: "flush", flush_id: 7, t: 2, effects: [1, 2], trigger_signal_ids: [42]},
        {v: 1, type: "event", t: 3, event_type: "click", target_component: "Counter",
         handler_name: "increment", flush_ids: [7]}
      ]
      res = post_json(server.port, "/__devtools/ingest", JSON.generate({v: 1, messages: messages}))
      assert_equal 200, res.code.to_i
      assert_equal messages.size, JSON.parse(res.body)["accepted"]

      expected = JSON.parse(JSON.generate(messages)) # JSON 回环后与线上一致（string 键）
      [a, b].each do |client|
        assert_equal expected, messages.size.times.map { client.next_data }
      end
    ensure
      a&.close
      b&.close
    end
  end

  def test_empty_ingest_batch_is_accepted
    with_server do |server|
      res = post_json(server.port, "/__devtools/ingest", JSON.generate({v: 1, messages: []}))
      assert_equal 200, res.code.to_i
      assert_equal 0, JSON.parse(res.body)["accepted"]
    end
  end

  def test_cmd_broadcasts_verbatim_to_panel_and_bridge
    raw = JSON.generate({v: 1, type: "cmd", cmd: "set_signal", signal_id: 42, value: {"nested" => [1, 2]}})
    with_server do |server|
      panel = SseClient.new(server.port)
      bridge = SseClient.new(server.port)
      res = post_json(server.port, "/__devtools/cmd", raw)
      assert_equal 200, res.code.to_i

      [panel, bridge].each do |client|
        assert_equal JSON.parse(raw), client.next_data
      end
    ensure
      panel&.close
      bridge&.close
    end
  end

  # ── 校验 ──────────────────────────────────────────────

  def test_ingest_rejects_malformed_payloads
    with_server do |server|
      post = ->(body) { post_json(server.port, "/__devtools/ingest", body) }

      assert_equal 400, post.call("not json").code.to_i
      assert_equal 400, post.call(JSON.generate({v: 2, messages: []})).code.to_i
      assert_equal 400, post.call(JSON.generate({v: 1})).code.to_i
      assert_equal 400, post.call(JSON.generate({v: 1, messages: "nope"})).code.to_i
      assert_equal 400, post.call(JSON.generate({v: 1, messages: [{type: "hello"}]})).code.to_i
      assert_equal 400, post.call(JSON.generate({v: 1, messages: ["x"]})).code.to_i
    end
  end

  def test_ingest_rejects_oversized_batch
    with_server do |server|
      messages = Array.new(Server::MAX_INGEST_MESSAGES + 1) { {v: 1, type: "ping_probe"} }
      res = post_json(server.port, "/__devtools/ingest", JSON.generate({v: 1, messages: messages}))
      assert_equal 400, res.code.to_i
    end
  end

  def test_cmd_rejects_malformed_payloads
    with_server do |server|
      post = ->(body) { post_json(server.port, "/__devtools/cmd", body) }

      assert_equal 400, post.call("not json").code.to_i
      assert_equal 400, post.call(JSON.generate({v: 1, type: "cmd"})).code.to_i
      assert_equal 400, post.call(JSON.generate({v: 1, type: "cmd", cmd: 42})).code.to_i
      assert_equal 400, post.call(JSON.generate({v: 1, type: "set_signal", cmd: "set_signal"})).code.to_i
    end
  end

  def test_unknown_path_404_and_wrong_method_405
    with_server do |server|
      res = http(server.port, :Get, "/nope")
      assert_equal 404, res.code.to_i
      assert_match(/not found/, JSON.parse(res.body)["error"])

      res = http(server.port, :Get, "/__devtools/ingest")
      assert_equal 405, res.code.to_i
      assert_equal "POST", res["allow"]

      res = http(server.port, :Post, "/__devtools/stream", body: "{}", headers: {"Content-Type" => "application/json"})
      assert_equal 405, res.code.to_i
    end
  end

  # ── ping 清扫 ─────────────────────────────────────────

  def test_ping_sweep_sends_comment_frames_and_sweeps_zombies
    with_server(ping_interval: 0.2) do |server|
      live = SseClient.new(server.port)
      zombie = SseClient.new(server.port)
      assert_equal 2, server.client_count

      # 15s 周期的测试加速版：comment ping 到达且不占消息位
      assert_equal :comment, live.next_event(3).kind
      assert_equal ": ping", live.next_event(3).data

      # 僵尸连接（浏览器直接关）在 ping 引发的写失败后被清扫
      zombie.close
      wait_until(5) { server.client_count == 1 }

      # 活连接照常收广播
      message = {v: 1, type: "hello", app_name: "still-alive"}
      post_json(server.port, "/__devtools/ingest", JSON.generate({v: 1, messages: [message]}))
      assert_equal JSON.parse(JSON.generate(message)), live.next_data
      assert_equal 1, server.client_count
    ensure
      live&.close
      zombie&.close
    end
  end

  # ── 生命周期 ──────────────────────────────────────────

  def test_port_zero_gets_ephemeral_port_and_stop_releases_it
    server = Server.new(port: 0).start
    port = server.port
    refute_nil port
    assert_operator port, :>, 0

    TCPSocket.new("127.0.0.1", port).close # 启动后可连
    server.stop
    assert_raises(Errno::ECONNREFUSED) { TCPSocket.new("127.0.0.1", port) }
  end

  def test_stop_closes_open_stream_connections
    server = Server.new(port: 0).start
    client = SseClient.new(server.port)
    # 注册发生在服务端 pump 线程：客户端 TCP 连接返回不代表已登记——
    # CI 高负载下直接断言会竞态（Expected 1 Actual 0），改轮询等待
    wait_until(3) { server.client_count == 1 }

    server.stop
    wait_until(3) { server.client_count.zero? }
  ensure
    client&.close
    server&.stop
  end

  # ── CLI 解析 ──────────────────────────────────────────

  def test_parse_args
    assert_equal Server::DEFAULT_PORT, Server.parse_args([])
    assert_equal 1234, Server.parse_args(["-p", "1234"])
    assert_raises(ArgumentError) { Server.parse_args(["-p"]) }
    assert_raises(ArgumentError) { Server.parse_args(["-p", "abc"]) }
    assert_raises(ArgumentError) { Server.parse_args(["-p", "-x"]) }
  end
end
