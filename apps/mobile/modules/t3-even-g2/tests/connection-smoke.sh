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
  "$g2_module_dir/tests/T3EvenG2ConnectionSmoke.swift" \
  -o "$g2_test_dir/t3-g2-connection-smoke"
"$g2_test_dir/t3-g2-connection-smoke"
