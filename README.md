# @nzip/lofi-node

A self-hostable sync node for [lofi](../lofi) apps: a Jazz 2.0 sync server
(jazz-napi `JazzServer`) plus iroh node-to-node transport
([db-iroh-ffi](../db-iroh-ffi) via `Deno.dlopen`). Browsers keep speaking
Jazz's WebSocket protocol — `JAZZ_SERVER_URL` points at a node and lofi's
`adapter: "jazz"` contract (DX-SYNC-01) is untouched. iroh lives entirely in
the daemon: two nodes pair by ticket and replicate over a WS-over-iroh tunnel,
dialed by key, no static IPs.

**Status: private prove-out.** The native layer is a trimmed vendor of
upstream [n0-computer/iroh-ffi](https://github.com/n0-computer/iroh-ffi)'s
`iroh-js` napi crate, built in-repo (`cargo build --release` in
`native/iroh-js/`; see `native/iroh-js/UPSTREAM.md` for provenance and the
tag-bump procedure). Override with `LOFI_NODE_IROH=<path>`.

## Layout

| Piece | Where |
|---|---|
| One-constructor library | `src/node.ts` (`createSyncNode`) |
| WS+HTTP-over-iroh tunnel | `src/tunnel.ts` (HELLO/TEXT/BIN/CLOSE frames, 1 conn : 1 ws or 1 http request) |
| Vendored iroh-js napi crate | `native/iroh-js/` (upstream + `lofi_ext.rs` Buffer framing) |
| Addon loader + typed surface | `src/native/addon.ts`, `src/native/loader.ts` |
| Adapter (IrohNode/IrohConn) | `src/iroh/node.ts` |
| Ticket shape check (tickets are upstream `EndpointTicket` strings) | `src/ticket.ts` |
| Jazz wrapper (pinned `2.0.0-alpha.53`) | `src/jazz.ts` |
| CLI: init / start / pair / status | `cli.ts` |
| In-process test mesh (no iroh) | `testing/mod.ts` |

## Usage

```sh
deno run -A cli.ts init            # data dir, app id, secrets, iroh key
deno run -A cli.ts start           # prints Jazz URL + pairing ticket
deno run -A cli.ts pair LFN1.…     # persist peer election; restart to apply
```

Library:

```ts
import { createSyncNode } from "@nzip/lofi-node";
const node = await createSyncNode({
  appId, backendSecret, adminSecret,
  dataDir: "./data",
  upstream: { peer: "LFN1.…" },   // or { url: "wss://cloud.jazz.tools/…" } or "none"
});
node.url;       // -> JAZZ_SERVER_URL
node.ticket();  // -> share with the peer
```

## Design decisions

- **napi async, not a flat C ABI.** The vendored iroh-js crate exposes real
  Promises; `acceptNext()` resolves `null` on `endpoint.close()`, so the
  accept loop exits cleanly. The one extension (`lofi_ext.rs`) adds
  Buffer-based length-prefixed framing — upstream's `Array<number>` stream
  I/O measured 7.1 MiB/s at gate 0. Never call the upstream watch APIs: at
  v1.1.0 they panic outside a tokio context and abort the process.
- **The tunnel terminates WS on both ends**, so the dialer forwards the upgrade
  path/subprotocol in a HELLO frame and the acceptor replays them against its
  local JazzServer.
- **No silent degradation** (lofi's boot-gate ethos): a missing/unsupported
  dylib leaves the Jazz server up but reports `mesh: unavailable — <reason>`,
  and pairing throws `MeshUnavailableError`.
- **Version invariant:** this package pins the exact `jazz-napi` alpha that the
  consuming lofi app pins (`2.0.0-alpha.53`). Wire compat across alphas is not
  guaranteed; bump in lockstep.

## Native layer

Executed per [docs/port-iroh-js.md](docs/port-iroh-js.md): `native/iroh-js/`
vendors upstream at v1.1.0 (endpoint/key/net/path/relay/ticket/watch modules;
services dropped), plus `lofi_ext.rs`. db-iroh-ffi is no longer a dependency.
Live tunnel connection stats surface in `SyncNodeStatus.mesh.connections`.

Prebuilts (`native/iroh-js/prebuilt/<triple>/`): macOS arm64 (built on a
mac), Linux x86_64 + aarch64 (Nix host via `nix develop -c
./scripts/cross-build.sh`). **Windows is open**: napi-build's `*-gnu` path
needs a libnode.dll import lib (upstream ships msvc, delay-loaded) — needs
cargo-xwin or a Windows CI runner.

## Tests

```sh
deno task test    # codec units always; iroh tunnel + jazz boot integration
                  # auto-skip when the dylib / napi build is unavailable
```

## Roadmap

- Convergence test: lofi's two-client Playwright fixtures against two paired
  nodes (the real spike exit-criterion).
- Runtime `pair()` without restart (needs JazzServer restart orchestration).
- `deno compile` packaging with embedded dylibs (doorbearer's
  extract-to-versioned-cache loader).
- Away-from-home story: `upstream: "cloud"` chaining behind one flag.
