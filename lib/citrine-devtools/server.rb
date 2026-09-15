# frozen_string_literal: true

require "rack"
require "puma"
require "puma/server"
require "json"

module Citrine
  module DevTools
    # DevTools 中继服务（M2-2）：浏览器桥接脚本与调试面板之间的消息总线。
    #
    # 端点与消息格式见 docs/PROTOCOL.md（传输协议 v1）——协议是契约，本文件是实现：
    #   GET  /__devtools/stream  SSE 下行流（面板与桥接共用；15s comment ping 清扫僵尸连接）
    #   POST /__devtools/ingest  桥接批量上报 {v:1, messages:[…]}，逐条广播给所有 stream 客户端
    #   POST /__devtools/cmd     面板指令，语义原样广播（桥接消费、面板忽略）
    #   GET  /                   调试面板页面（panel.html，M3）
    #   GET  /panel.js           调试面板脚本（panel.js，M3）
    #   GET  /bridge.js          桥接脚本静态资源
    #   GET  /vendor/cytoscape.min.js  依赖图渲染库（M4，vendored cytoscape 3.30.4，MIT）
    # 所有响应带 CORS `Access-Control-Allow-Origin: *` 并处理 OPTIONS 预检（仅 localhost 调试场景）。
    # v1 单会话：不按会话隔离，多窗口消息混合（协议 §会话）。
    #
    # 实现借 citrine DevServer 的成熟模式：Rack + Puma、每连接 Queue + 泵线程、
    # rack.hijack 接管 SSE 连接、定期 ping 让僵尸连接的写失败暴露并被清扫。
    class Server
      PROTOCOL_VERSION = 1
      DEFAULT_PORT = 9527
      HOST = "127.0.0.1"

      # 协议规定的 SSE ping 清扫周期（秒）：僵尸连接（浏览器已关、无消息可写）平时不暴露，
      # 定期 comment ping 让写动作发生，写失败即被清扫
      SSE_PING_INTERVAL = 15

      # 单批 ingest 条数上限：v1 本地调试的安全阀（协议未规定上限，超出回 400 提示分批）
      MAX_INGEST_MESSAGES = 1000

      # SSE 注册表条目：每连接一个队列，泵线程阻塞取消息写给客户端
      Client = Struct.new(:queue, :io)

      # 桥接脚本随 gem 分发，/bridge.js 原样吐出（请求时复读文件，开发期改完即生效）
      BRIDGE_JS_PATH = File.expand_path("bridge.js", __dir__)

      # 面板资产随 gem 分发（M3）：/ 与 /panel.js 原样吐出（同 bridge_js 的请求时复读模式）
      PANEL_HTML_PATH = File.expand_path("panel.html", __dir__)
      PANEL_JS_PATH = File.expand_path("panel.js", __dir__)

      # 依赖图渲染库（M4）：vendored cytoscape（MIT），面板 <script src="/vendor/cytoscape.min.js"> 引入
      CYTOSCAPE_JS_PATH = File.expand_path("vendor/cytoscape.min.js", __dir__)

      attr_reader :port

      # 命令行解析（纯函数，便于单测）：citrine-devtools serve [-p 端口]
      def self.parse_args(args)
        port = DEFAULT_PORT
        i = 0
        while i < args.length
          arg = args[i]
          if arg == "-p"
            value = args[i + 1]
            raise ArgumentError, "-p 需要一个端口参数（如 -p 9527）" if value.nil? || value.start_with?("-")

            begin
              port = Integer(value, 10)
            rescue ArgumentError
              raise ArgumentError, "-p 端口必须是整数（收到 #{value.inspect}）"
            end
            i += 2
          else
            warn "未知参数 #{arg}，已忽略（用法：citrine-devtools serve [-p 端口]）"
            i += 1
          end
        end
        port
      end

      def self.run!(args)
        new(port: parse_args(args)).run
      rescue ArgumentError => e
        warn "参数错误：#{e.message}"
        exit 1
      end

      # port 0 表示随机空闲端口（测试用）；ping_interval 仅供测试缩短清扫周期
      def initialize(port: DEFAULT_PORT, ping_interval: SSE_PING_INTERVAL)
        @requested_port = port
        @ping_interval = ping_interval
        @clients = []
        @mutex = Mutex.new
        @puma = nil
        @ping_thread = nil
        @port = nil
      end

      # 非阻塞启动（Puma 在后台线程受理连接），返回 self；实际绑定端口见 #port
      def start
        @puma = Puma::Server.new(rack_app)
        @puma.add_tcp_listener HOST, @requested_port
        @port = @puma.connected_ports.first
        start_ping_sweep
        @puma.run
        self
      end

      # 阻塞运行（CLI 入口）
      def run
        start
        puts "citrine-devtools 中继 → http://localhost:#{@port}/"
        puts "  调试面板: http://localhost:#{@port}/"
        puts "  被调试页引入: <script src=\"http://127.0.0.1:#{@port}/bridge.js\"></script>"
        sleep
      end

      # 关闭：停 ping 清扫、断开全部 SSE 连接、停 Puma 并释放监听端口
      def stop
        @ping_thread&.kill
        @ping_thread = nil
        @mutex.synchronize { @clients.dup }.each do |client|
          begin
            client.io.close # 先关 io，泵线程被唤醒后的写必然失败并注销
          rescue StandardError
            nil
          end
          client.queue << :ping
        end
        @puma&.stop(true)
        @puma = nil
        self
      end

      # SSE 注册表规模（测试与运维观察口）
      def client_count
        @mutex.synchronize { @clients.size }
      end

      private

      # ── Rack 路由 ─────────────────────────────────────────

      def rack_app
        @rack_app ||= ->(env) { route(env) }
      end

      def route(env)
        request = Rack::Request.new(env)
        return preflight if request.options?

        case request.path
        when "/__devtools/stream"
          request.get? ? stream(env) : method_not_allowed("GET")
        when "/__devtools/ingest"
          request.post? ? ingest(env) : method_not_allowed("POST")
        when "/__devtools/cmd"
          request.post? ? cmd(env) : method_not_allowed("POST")
        when "/"
          request.get? ? static_file(PANEL_HTML_PATH, "text/html", "/") : method_not_allowed("GET")
        when "/panel.js"
          request.get? ? static_file(PANEL_JS_PATH, "application/javascript", "/panel.js") : method_not_allowed("GET")
        when "/bridge.js"
          request.get? ? respond(200, "application/javascript", bridge_js) : method_not_allowed("GET")
        when "/vendor/cytoscape.min.js"
          request.get? ? static_file(CYTOSCAPE_JS_PATH, "application/javascript", "/vendor/cytoscape.min.js") : method_not_allowed("GET")
        else
          respond(404, "application/json", json_error("not found: #{request.path}"))
        end
      rescue JSON::ParserError
        respond(400, "application/json", json_error("请求体不是合法 JSON"))
      rescue StandardError => e
        respond(500, "application/json", json_error("#{e.class}: #{e.message}"))
      end

      # ── 上行：ingest / cmd ────────────────────────────────

      # 桥接批量上报：校验后逐条广播（一条消息一个 SSE 事件，保序）
      def ingest(env)
        body = JSON.parse(env["rack.input"].read)
        unless body.is_a?(Hash) && body["v"] == PROTOCOL_VERSION && body["messages"].is_a?(Array)
          return respond(400, "application/json", json_error("ingest 需要 {v:1, messages:[…]}"))
        end

        messages = body["messages"]
        if messages.size > MAX_INGEST_MESSAGES
          return respond(400, "application/json",
                         json_error("单批消息超过上限 #{MAX_INGEST_MESSAGES} 条，请分批上报"))
        end
        unless messages.all? { |m| valid_message?(m) }
          return respond(400, "application/json",
                         json_error("每条消息都必须是带 v:1 与 type 的 JSON 对象"))
        end

        messages.each { |m| broadcast(JSON.generate(m)) }
        # M2-4 验收诊断：ingest 记账（每批一行：类型统计）
        tally = messages.group_by { |m| m["type"] }.transform_values(&:size)
        puts "[ingest] #{messages.size} 条 #{tally}" if ENV["CITRINE_DEVTOOLS_DEBUG"]
        respond(200, "application/json",
                JSON.generate({v: PROTOCOL_VERSION, ok: true, accepted: messages.size}))
      end

      def valid_message?(message)
        message.is_a?(Hash) && message["v"] == PROTOCOL_VERSION && message["type"].is_a?(String)
      end

      # 面板指令：校验后语义原样广播（紧凑重排保证 SSE 单行成帧；桥接消费、面板忽略）
      def cmd(env)
        body = JSON.parse(env["rack.input"].read)
        unless body.is_a?(Hash) && body["v"] == PROTOCOL_VERSION &&
               body["type"] == "cmd" && body["cmd"].is_a?(String)
          return respond(400, "application/json",
                         json_error("cmd 需要 {v:1, type:\"cmd\", cmd:\"…\", …}"))
        end

        broadcast(JSON.generate(body))
        respond(200, "application/json", JSON.generate({v: PROTOCOL_VERSION, ok: true}))
      end

      # ── 下行：SSE 广播（rack.hijack 接管连接）──────────────

      def stream(env)
        io = env["rack.hijack"].call
        io.write "HTTP/1.1 200 OK\r\n" \
                 "Content-Type: text/event-stream\r\n" \
                 "Cache-Control: no-cache\r\n" \
                 "Connection: keep-alive\r\n" \
                 "Access-Control-Allow-Origin: *\r\n" \
                 "\r\n"
        client = Client.new(Queue.new, io)
        @mutex.synchronize { @clients << client }
        Thread.new { pump_client(client) }
        [-1, {}, []] # 已劫持连接，Rack 不再处理响应
      end

      # 每连接一个泵线程：从队列取消息写成 SSE 帧；写失败（对端已关）即注销。
      # ping 帧（:ping）只作心跳不占消息位——僵尸连接靠它暴露写失败并被清扫。
      def pump_client(client)
        loop do
          message = client.queue.pop
          client.io.write(message == :ping ? ": ping\n\n" : "data: #{message}\n\n")
        end
      rescue StandardError
        @mutex.synchronize { @clients.delete(client) } # 连接断开时清理
      end

      def broadcast(payload)
        @mutex.synchronize { @clients.dup }.each { |client| client.queue << payload }
      end

      # 定期给所有 SSE 连接发 ping——协议规定的 15s comment ping 清扫周期
      def start_ping_sweep
        @ping_thread = Thread.new do
          loop do
            sleep @ping_interval
            @mutex.synchronize { @clients.dup }.each { |client| client.queue << :ping }
          end
        end
      end

      # ── 响应辅助 ──────────────────────────────────────────

      def respond(status, type, body)
        [status, {
          "content-type" => type,
          "content-length" => body.bytesize.to_s,
          "access-control-allow-origin" => "*"
        }, [body]]
      end

      def preflight
        [204, {
          "access-control-allow-origin" => "*",
          "access-control-allow-methods" => "GET, POST, OPTIONS",
          "access-control-allow-headers" => "content-type",
          "access-control-max-age" => "86400",
          "content-length" => "0"
        }, []]
      end

      def method_not_allowed(allow)
        [405, {
          "content-type" => "application/json",
          "content-length" => json_error("method not allowed（请用 #{allow}）").bytesize.to_s,
          "allow" => allow,
          "access-control-allow-origin" => "*"
        }, [json_error("method not allowed（请用 #{allow}）")]]
      end

      def json_error(message)
        JSON.generate({v: PROTOCOL_VERSION, error: message})
      end

      # 面板等静态资产：请求时复读文件（开发期改完即生效）；文件缺失（如旧版安装）
      # 按静态资源口径回 404，而不是走通用 rescue 的 500
      def static_file(path, type, public_name)
        unless File.exist?(path)
          return respond(404, "application/json", json_error("static asset not found: #{public_name}"))
        end

        respond(200, type, File.binread(path))
      end

      def bridge_js
        File.binread(BRIDGE_JS_PATH)
      end
    end
  end
end
