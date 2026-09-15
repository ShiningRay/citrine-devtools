# frozen_string_literal: true

# 测试用 SSE 客户端：裸 TCP 读 SSE 帧（data: / comment），事件进队列供断言。
# 仅本仓测试使用，不作产品代码；红线约束：不占固定端口，用完 close。
class SseClient
  Event = Struct.new(:kind, :data)

  attr_reader :headers

  def initialize(port, path: "/__devtools/stream")
    @socket = TCPSocket.new("127.0.0.1", port)
    @socket.write "GET #{path} HTTP/1.1\r\nHost: 127.0.0.1:#{port}\r\n" \
                  "Accept: text/event-stream\r\n\r\n"
    @buffer = +""
    @events = Queue.new
    read_headers
    @thread = Thread.new { pump }
  end

  # 下一条数据事件（已解析 JSON），跳过途中的 ping comment 帧；超时直接抛错让测试失败
  def next_data(timeout = 5)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    loop do
      remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
      raise "等待 data 事件超时（#{timeout}s）" if remaining <= 0

      event = next_event(remaining)
      return event.data if event.kind == :data
    end
  end

  def next_event(timeout = 5)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    loop do
      remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
      raise "等待 SSE 事件超时（#{timeout}s）" if remaining <= 0

      begin
        return @events.pop(true)
      rescue ThreadError
        sleep 0.02
      end
    end
  end

  def close
    @socket.close unless @socket.closed?
    @thread&.join(2)
  end

  private

  def read_headers
    until @buffer.include?("\r\n\r\n")
      @buffer << @socket.readpartial(16 * 1024)
    end
    @headers, rest = @buffer.split("\r\n\r\n", 2)
    @buffer = rest || +""
  end

  def pump
    loop do
      @buffer << @socket.readpartial(16 * 1024)
      extract
    end
  rescue IOError, SystemCallError, EOFError
    # 连接被对端/测试关闭，泵线程退出
  end

  # SSE 帧以空行分隔；comment（: 开头）与 data 帧都可能出现
  def extract
    while (index = @buffer.index("\n\n"))
      block = @buffer.slice!(0, index + 2)
      lines = block.split("\n").reject(&:empty?)
      data = lines.select { |l| l.start_with?("data: ") }.map { |l| l.delete_prefix("data: ") }.join("\n")
      if !data.empty?
        @events << Event.new(:data, JSON.parse(data))
      elsif (comment = lines.find { |l| l.start_with?(":") })
        @events << Event.new(:comment, comment)
      end
    end
  end
end
