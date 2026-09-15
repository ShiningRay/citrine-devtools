# frozen_string_literal: true

require "rake/testtask"
require "bundler/gem_tasks" # rake release（Trusted Publishing 发布路径，同 citrine）

Rake::TestTask.new(:test) do |t|
  t.libs << "lib" << "test"
  t.test_files = FileList["test/**/*_test.rb"]
end

task default: :test
