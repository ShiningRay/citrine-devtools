# frozen_string_literal: true

$LOAD_PATH.unshift File.expand_path("../lib", __dir__)

require "minitest/autorun"
require "net/http"
require "json"
require "socket"
require_relative "sse_client"
