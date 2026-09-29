#!/usr/bin/env bash
set -euo pipefail

# Compile the real connection driver against a fake Bluetooth boundary. The
# mock module lives only in this temporary search path, never in an iOS build.
g2_module_dir="$(cd "$(dirname "$0")/.." && pwd)"
g2_test_dir="$(mktemp -d "${TMPDIR:-/tmp}/t3-g2-connection.XXXXXX")"
trap 'rm -rf "$g2_test_dir"' EXIT

xcrun swiftc -module-cache-path "$g2_test_dir/cache" \
  -emit-library -emit-module -module-name CoreBluetooth \
  "$g2_module_dir/tests/support/CoreBluetooth.swift" \
  -o "$g2_test_dir/libCoreBluetooth.dylib"
xcrun swiftc -module-cache-path "$g2_test_dir/cache" \
  -I "$g2_test_dir" -L "$g2_test_dir" -lCoreBluetooth \
  -Xlinker -rpath -Xlinker "$g2_test_dir" \
  "$g2_module_dir/ios/T3EvenG2Connection.swift" \
  "$g2_module_dir/ios/T3EvenG2Protocol.swift" \
  "$g2_module_dir/ios/T3EvenG2ThreadPicker.swift" \
  "$g2_module_dir/ios/T3EvenG2History.swift" \
  "$g2_module_dir/tests/T3EvenG2ConnectionSmoke.swift" \
  -o "$g2_test_dir/t3-g2-connection-smoke"
# Keep real firmware deadlines bounded independently for each regression group.
if [[ $# -gt 0 ]]; then
  "$g2_test_dir/t3-g2-connection-smoke" "$@"
  exit
fi
"$g2_test_dir/t3-g2-connection-smoke" --startup-input
"$g2_test_dir/t3-g2-connection-smoke" --diagnostics
"$g2_test_dir/t3-g2-connection-smoke" --listening
"$g2_test_dir/t3-g2-connection-smoke" --heartbeats
"$g2_test_dir/t3-g2-connection-smoke" --history
"$g2_test_dir/t3-g2-connection-smoke" --sending
"$g2_test_dir/t3-g2-connection-smoke"
