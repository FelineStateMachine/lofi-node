#!/usr/bin/env bash
# Cross-build the vendored iroh-js napi addon for lofi-node's platform matrix.
#
# Linux + Windows build on any x86_64 Linux host via cargo-zigbuild; macOS
# targets build natively on a mac (Apple SDK is not redistributable). Run
# inside the flake dev shell:  nix develop -c ./scripts/cross-build.sh
#
# Artifacts land in dist/<triple>/ (cargo names; the Deno loader stages its
# own .node shim at load time).
set -euo pipefail
cd "$(dirname "$0")/.."

# Windows is NOT in this matrix: napi-build's *-gnu path needs a libnode.dll
# import library (upstream ships Windows as msvc, delay-loaded against the
# host exe). A Windows artifact of OUR crate needs cargo-xwin (msvc cross) or
# a Windows CI runner — tracked in README.
linux_targets=(
  x86_64-unknown-linux-gnu
  aarch64-unknown-linux-gnu
)

artifact_name() {
  echo "libnumber0_iroh.so"
}

for t in "${linux_targets[@]}"; do
  echo "==> cargo zigbuild --release --target $t"
  cargo zigbuild --release --target "$t"
  name="$(artifact_name "$t")"
  mkdir -p "dist/$t"
  cp "target/$t/release/$name" "dist/$t/$name"
  echo "    -> dist/$t/$name"
done

cat <<'EOF'

macOS targets build on a mac (native toolchain, no Nix needed):
  cargo build --release   # -> target/release/libnumber0_iroh.dylib
EOF
