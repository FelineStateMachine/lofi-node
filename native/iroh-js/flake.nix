{
  description = "lofi-node iroh-js cross-compilation dev shell (Linux + Windows via zig; macOS builds on a mac)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    rust-overlay.url = "github:oxalica/rust-overlay";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, rust-overlay, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ (import rust-overlay) ];
        };
        rust = pkgs.rust-bin.stable.latest.default.override {
          targets = [
            "x86_64-unknown-linux-gnu"
            "aarch64-unknown-linux-gnu"
            "x86_64-pc-windows-gnu"
          ];
        };
      in {
        devShells.default = pkgs.mkShell {
          packages = [
            rust
            pkgs.zig            # cross cc/linker for libc + ring's C/asm
            pkgs.cargo-zigbuild # cargo <-> zig glue, per-target
            pkgs.pkg-config
          ];
          shellHook = ''
            echo "lofi-node iroh-js cross shell — cargo-zigbuild $(cargo-zigbuild --version 2>/dev/null | head -1)"
            echo "  run: ./scripts/cross-build.sh"
          '';
        };
      });
}
