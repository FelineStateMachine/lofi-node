# Plan: replace db-iroh-ffi with a port of upstream iroh-ffi (iroh-js)

## Why

lofi-node currently binds iroh through `../db-iroh-ffi` — a hand-written flat C ABI built for the
Doorbearer game. It works (all fixtures green), but it is the wrong long-term base for a published
package:

- **Provenance**: db-iroh-ffi's surface is game-shaped (docs determinism hinge, encrypted lineage
  store, gossip barriers) and lofi-node uses none of it — only connections + framed messages. A
  reviewer of @nzip/lofi-node cannot tell what the FFI is, where it came from, or why it exists.
- **Upstream tracking**: n0-computer/iroh-ffi is the official, actively hardened binding surface for
  iroh 1.x (v1.1.0, July 2026). A hand-rolled ABI diverges forever; a port hardens as upstream
  hardens, tag by tag.
- **Portability**: db-iroh-ffi is a sibling-checkout git dependency; lofi-node should build and
  vendor its own native layer.

Upstream ships two binding crates: a uniffi crate (Swift/Kotlin/Python) and `iroh-js/` — a
**napi-rs** crate (napi 3, async) whose generator emits `index.js` + `index.d.ts` and per-platform
prebuilds. iroh-js is the porting base because:

- Deno loads napi addons natively — jazz-napi already proves it in this stack.
- napi async fns return real Promises: no parked FFI-pool threads.
- `Endpoint.acceptNext()` resolves `null` on `close()` — erases db-iroh-ffi's known
  accept-cancellation gap by design.
- Upstream already exposes what we hand-rolled or missed: `EndpointTicket` (replaces the custom
  `LFN1.` codec, interoperable with the iroh ecosystem), `ConnectionStats` / `PathSnapshot` / watch
  APIs (direct-vs-relay metrics for `status()`), builder presets + `secretKey(bytes)` for persisted
  identity.

## Scope discipline

Take only what lofi-node uses: connections. **No** docs / blobs / gossip / encrypted store, **no**
services, **no** android glue. If a future feature needs gossip-presence or blob-backups, vendor
those upstream modules then, same procedure.

## Vendoring rules (the provenance contract)

1. **Trim at module level, never inside a file.** Vendored files stay byte-identical to upstream
   wherever possible so `diff -r` against a new upstream tag is the whole update procedure. Only
   permitted edits: `lib.rs`/`Cargo.toml` module + dependency lists, and compile fixes forced by a
   dropped module — every such line marked `// lofi-node: <reason>`.
2. **Extensions live only in `src/lofi_ext.rs`.** Upstream never collides.
3. **`native/iroh-js/UPSTREAM.md`** records: upstream repo/tag/commit, vendored file list, every
   marked delta, dropped modules and why, and the tag-bump procedure (fetch tag → diff → re-apply
   markers → run fixtures).
4. iroh-ffi is MIT/Apache-2.0 dual-licensed; vendor both licenses alongside.

## Module selection

| Upstream file                             | Verdict                                | Reason                                                          |
| ----------------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| `endpoint.rs`                             | vendor                                 | Endpoint/Builder, connect/acceptNext/close, watch APIs, streams |
| `key.rs`                                  | vendor                                 | SecretKey (`fromBytes` ← persisted `iroh.key`), EndpointId      |
| `net.rs`                                  | vendor                                 | EndpointAddr, EndpointTicket                                    |
| `relay.rs`                                | vendor                                 | RelayMap/Mode/Config — required by builder presets              |
| `error.rs`                                | vendor                                 | error mapping                                                   |
| `path.rs`                                 | vendor only if endpoint.rs requires it | PathSnapshot powers `status()`; nice-to-have                    |
| `services.rs`, `android_init.rs`, `npm/*` | drop                                   | unused / upstream's packaging                                   |

Dependency diet follows: `iroh`, `iroh-base`, `iroh-relay` (no default features),
`napi`/`napi-derive`/`napi-build`, `anyhow`. Drop `iroh-services`; `iroh-metrics` only if
endpoint.rs demands it.

## The one extension: Buffer framed I/O

Upstream streams move bytes as `Array<number>` (`writeAll(buf:
Array<number>)`,
`readExact(...): Promise<Array<number>>`) — per-byte boxing plus two awaited hops per
length-prefixed message is a perf trap for sync frames. `lofi_ext.rs` adds:

```rust
#[napi] pub async fn write_frame(stream: &SendStream, data: Buffer) -> Result<()>
#[napi] pub async fn read_frame(stream: &RecvStream, max: u32) -> Result<Option<Buffer>>
```

u32-BE length prefix + payload, one await per message, `None` on clean stream end. `MAX_FRAME` sized
for Jazz sync payloads (16 MiB to start — measured, not inherited from the game's 64 MiB). If
upstream later grows Buffer I/O, the extension deletes.

## TS adapter mapping (contract-preserving)

`IrohNode`/`IrohConn` keep their current signatures — `tunnel.ts`, `node.ts`, and every fixture are
the regression spec.

| Current (db-iroh-ffi)              | Ported (iroh-js)                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `openIrohLib()` dlopen + ABI probe | `createRequire` of the `.node` addon; version probe = addon export                            |
| `IrohNode.open(lib, secret)`       | `Endpoint.builder()` + `applyN0()` + `secretKey(bytes)` + bind + `setAlpns([LOFI_ALPN])`      |
| `node.id()` / `node.addr()`        | `endpoint.id()` / `endpoint.addr()`                                                           |
| `node.addAddr(bytes)`              | dropped — `connect(EndpointAddr)` takes the addr directly                                     |
| `node.connect(addrBytes)`          | `endpoint.connect(ticket.endpointAddr(), LOFI_ALPN)` → `openBi()`                             |
| `node.accept()` (uncancellable)    | `acceptNext()` → `accept()` → `connect()` → `acceptBi()`; **null on close = clean loop exit** |
| `conn.sendMsg` / `conn.recvMsg`    | `writeFrame(bi.send, buf)` / `readFrame(bi.recv, MAX_FRAME)`                                  |
| ticket `LFN1.` + postcard addr     | `EndpointTicket` string (breaking, pre-publish, no migration)                                 |
| —                                  | NEW: `conn.stats()` / `conn.paths()` surfaced into `SyncNodeStatus.mesh`                      |

The `mesh: unavailable` boot-gate contract is unchanged: addon load failure → typed reason, Jazz
stays up, pairing throws.

## Build & packaging

- `native/iroh-js/`: cargo crate; `napi build --release` emits the `.node` plus regenerated
  `index.d.ts`/`index.js` (committed — they are the typed contract, reviewable in diffs).
- Dev resolution order (as today): `LOFI_NODE_IROH` env → explicit option → `native/iroh-js` build
  output → `prebuilt/<triple>/`.
- Cross-compilation: the recipe already proven in db-iroh-ffi — repo-local Nix shell +
  cargo-zigbuild (Linux x86_64/aarch64, Windows x86_64), macOS on a mac, `ring` TLS.

## Phases

1. **Gate 0 — spike (blocks everything else):** build upstream iroh-js UNMODIFIED, load under Deno.
   Smoke: endpoint bind, ticket round-trip, loopback connect/accept, bi-stream echo, `close()`
   resolving a pending `acceptNext()` as null, watch-callback fires (threadsafe fns under Deno).
   Measure Array<number> throughput to size the extension's necessity.
2. Vendor the trimmed crate into `native/iroh-js/`, drop modules per table, write `UPSTREAM.md`;
   same smoke passes against the trimmed build.
3. `lofi_ext.rs` framed I/O + TS adapter behind the existing `IrohNode`/`IrohConn` contract; full
   fixture suite green (tunnel echo, pair, convergence ×3) with db-iroh-ffi untouched as fallback.
4. Switch tickets to `EndpointTicket`; surface stats/paths in `status()`; delete the flat-C loader
   and the db-iroh-ffi dependency; update README.
5. Prebuilt cross-compile artifacts + resolution order finalized.

## What this dissolves

- The "reconcile db-iroh-ffi before publishing" gate — lofi-node no longer depends on it;
  db-iroh-ffi remains Doorbearer's, unreconciled.
- The accept-cancellation upstream ask, the nonblocking-FFI thread pool, the custom ticket codec,
  and the ABI-version handshake (napi addon exports replace it).
