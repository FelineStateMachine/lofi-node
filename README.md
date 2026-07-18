# @nzip/lofi-node

The first-class way to self-host the sync backend for
[lofi](https://github.com/FelineStateMachine/lofi) apps: one daemon embedding a Jazz 2.0 sync server
plus [iroh](https://iroh.computer) node-to-node transport. Browsers keep speaking Jazz's protocol —
`JAZZ_SERVER_URL` points at your node and lofi's `adapter: "jazz"` contract is untouched. Two nodes
pair by ticket and replicate over iroh: dialed by key, hole-punched, no static IPs, no cloud
dependency.

- Hosting walkthrough: [docs/hosting-lofi-apps.md](docs/hosting-lofi-apps.md)
- Native layer provenance: [native/iroh-js/UPSTREAM.md](native/iroh-js/UPSTREAM.md)
- License: [MIT](LICENSE)

## Quick start

Run straight from JSR with `dx` (Deno's npx — `deno x`):

```sh
dx -A jsr:@nzip/lofi-node/cli init --port 4802     # ticket-gated by default; --open opts out
dx -A jsr:@nzip/lofi-node/cli start                # gate URL + node-pairing ticket
dx -A jsr:@nzip/lofi-node/cli ticket issue --label phone   # app-connect ticket (shown once)
```

Equivalent forms:

```sh
deno run -A jsr:@nzip/lofi-node/cli start                  # plain deno
deno install -g -A -n lofi-node jsr:@nzip/lofi-node/cli    # persistent `lofi-node` command
```

> Freshly published versions sit behind Deno's 24-hour
> [minimum-dependency-age](https://docs.deno.com/go/minimum-dependency-age) supply-chain gate.
> Within that window use `deno run --minimum-dependency-age=0 -A jsr:@nzip/lofi-node/cli …`
> (`deno x` does not yet accept the override).

On first start the native iroh layer is downloaded from this repo's GitHub release for the matching
version and sha256-verified against digests pinned inside the package. No Deno at all? Grab a
compiled binary from the [releases](https://github.com/FelineStateMachine/lofi-node/releases) (macOS
arm64, Linux x86_64/aarch64; the macOS binary is unsigned — clear quarantine with
`xattr -d com.apple.quarantine lofi-node-*`).

As a library:

```sh
deno add jsr:@nzip/lofi-node
```

The issued `lofisync1.…` ticket carries **location + secret**; the lofi app stores it
passkey-encrypted and uses its URL as the sync server — possession of the ticket is access,
revocation is `ticket revoke` (live sockets close with 4001). Format contract:
[docs/app-ticket.md](docs/app-ticket.md). Storage location is the user's choice (`--storage-path`
for NAS/mounted volumes, `--memory` for ephemeral).

Or embed it:

```ts
import { createSyncNode } from "@nzip/lofi-node";

const node = await createSyncNode({
  appId,
  backendSecret,
  adminSecret,
  dataDir: "./data",
  upstream: { peer: "endpoint…" }, // or { url: "wss://…" } or "none"
});
node.url; // -> JAZZ_SERVER_URL for the lofi app
node.ticket(); // -> share with the peer node
await node.pair(otherTicket); // re-elect upstream at runtime; port unchanged
node.status(); // jazz health, upstream, mesh + live conn stats (direct/relay, rtt)
```

## What you get

- **A real Jazz sync server** (jazz-napi `JazzServer`, SQLite-backed, `/health` endpoint,
  local-first auth) that any lofi app can use by URL.
- **Node-to-node replication over iroh**: pairing tickets are upstream `EndpointTicket` strings;
  sync and catalogue traffic (WS + HTTP) tunnel over QUIC, so two homes converge without port
  forwarding. Administering either node reaches the root through the tunnel.
- **Observability**: `status().mesh.connections` reports live tunnel connections with rtt and path
  counts (direct vs relay).
- **No silent degradation**: if the native layer can't load, the Jazz server still runs (LAN-only)
  and `status()` says exactly why pairing is off.
- **One binary**: `deno task compile` embeds the prebuilt native matrix and extracts it to a
  version-keyed OS cache at first run.

## Where lofi-node fits

- The data plane is Jazz 2.0 **alpha**, pinned exactly (`jazz-tools@2.0.0-alpha.53`); a node must
  run the same alpha as the app it serves — treat version bumps as coordinated. Early-stage
  software.
- Platforms: macOS arm64, Linux x86_64/aarch64 (prebuilt in-repo; or `deno task native` with a Rust
  toolchain). **Windows is a documented gap**: napi-build's `*-gnu` linking needs a libnode.dll
  import library (upstream ships msvc, delay-loaded); a Windows artifact needs cargo-xwin or a
  Windows CI runner. Until then Windows runs LAN-only with a typed `mesh: unavailable` reason.
- Schema deploys to a self-hosted node use the jazz-tools schema-project flow — see the hosting
  walkthrough, including the current alpha caveat on lofi's browser convergence gate (fails
  identically against lofi's own managed dev server; lofi-node has behavior parity).

## Architecture

| Piece                                   | Where                                         |
| --------------------------------------- | --------------------------------------------- |
| One-constructor library                 | `src/node.ts` (`createSyncNode`)              |
| WS+HTTP-over-iroh tunnel                | `src/tunnel.ts` (1 iroh conn : 1 ws / 1 http) |
| Vendored iroh-js napi crate (iroh 1.x)  | `native/iroh-js/` (+ `lofi_ext.rs` framing)   |
| Addon loader (dev shim / cache extract) | `src/native/addon.ts`, `src/native/loader.ts` |
| Adapter over the addon                  | `src/iroh/node.ts` (`IrohNode`/`IrohConn`)    |
| Jazz wrapper (pinned alpha)             | `src/jazz.ts`                                 |
| CLI: init / start / pair / status       | `cli.ts`                                      |
| In-process test mesh (no iroh)          | `testing/mod.ts`                              |

The native layer is a trimmed, provenance-tracked vendor of upstream
[n0-computer/iroh-ffi](https://github.com/n0-computer/iroh-ffi)'s `iroh-js` napi crate —
module-level vendoring, byte-identical files, every local edit marked `// lofi-node:`, one extension
module, tag bumps by `diff -r`. Design history: [docs/port-iroh-js.md](docs/port-iroh-js.md).

## Developing lofi-node

```sh
deno task native   # build the native addon (Rust; once, or per vendored change)
deno task check    # fmt --check + lint + typecheck — the PR gate
deno task test     # full suite; iroh/jazz integration auto-skips without the addon
```

Cross-compiling the prebuilt matrix runs on any x86_64 Linux host with Nix:
`nix develop -c ./scripts/cross-build.sh` in `native/iroh-js/`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for boundaries (vendoring rules, secrets policy, version pins).
