#!/usr/bin/env bash
set -euo pipefail

g2_module_dir="$(cd "$(dirname "$0")/.." && pwd)"
g2_test_dir="$(mktemp -d "${TMPDIR:-/tmp}/t3-g2-history.XXXXXX")"
trap 'rm -rf "$g2_test_dir"' EXIT

xcrun swiftc -module-cache-path "$g2_test_dir/cache" \
  "$g2_module_dir/ios/T3EvenG2Protocol.swift" \
  "$g2_module_dir/ios/T3EvenG2History.swift" \
  "$g2_module_dir/tests/T3EvenG2HistorySmoke.swift" \
  -o "$g2_test_dir/t3-g2-history-smoke"
"$g2_test_dir/t3-g2-history-smoke"
