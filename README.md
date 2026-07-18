# @nzip/lofi-node

A self-hostable sync node for [lofi](../lofi) apps: a Jazz 2.0 sync server
(jazz-napi `JazzServer`) plus iroh node-to-node transport
([db-iroh-ffi](../db-iroh-ffi) via `Deno.dlopen`). Browsers keep speaking
Jazz's WebSocket protocol — `JAZZ_SERVER_URL` points at a node and lofi's
`adapter: "jazz"` contract (DX-SYNC-01) is untouched. iroh lives entirely in
the daemon: two nodes pair by ticket and replicate over a WS-over-iroh tunnel,
dialed by key, no static IPs.

**Status: private prove-out.** Consumes the sibling `../db-iroh-ffi` checkout
(prebuilt or `target/release`) or `LOFI_NODE_IROH=<path>`; publishing waits on
reconciling db-iroh-ffi to a game-agnostic surface (see below).

## Layout

| Piece | Where |
|---|---|
| One-constructor library | `src/node.ts` (`createSyncNode`) |
| WS-over-iroh tunnel | `src/tunnel.ts` (HELLO/TEXT/BIN/CLOSE frames, 1 conn : 1 ws) |
| FFI binding (connections surface only) | `src/native/iroh.ts`, `src/iroh/node.ts` |
| Pairing ticket codec (`LFN1.…`) | `src/ticket.ts` |
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

- **Nonblocking FFI, not doorbearer's pump model.** Parking calls (`db_accept`,
  `db_conn_recv_msg`, `db_connect`, node open/close) are declared
  `nonblocking: true` and park FFI-pool threads, not the isolate. Safe because
  db-iroh-ffi's `send_msg` posts to a writer-task channel (never parks) on
  locks disjoint from the recv path, and registry/poison state is per-handle.
- **The tunnel terminates WS on both ends**, so the dialer forwards the upgrade
  path/subprotocol in a HELLO frame and the acceptor replays them against its
  local JazzServer.
- **No silent degradation** (lofi's boot-gate ethos): a missing/unsupported
  dylib leaves the Jazz server up but reports `mesh: unavailable — <reason>`,
  and pairing throws `MeshUnavailableError`.
- **Version invariant:** this package pins the exact `jazz-napi` alpha that the
  consuming lofi app pins (`2.0.0-alpha.53`). Wire compat across alphas is not
  guaranteed; bump in lockstep.

## db-iroh-ffi reconciliation list (before publishing)

Found while consuming the crate generically (tracked for the de-game-ification
pass in the db-iroh-ffi repo):

1. **`db_accept` cancellation** — nothing wakes a parked accept; `db_node_close`
   removes the handle but `incoming.pop()` never resolves. A daemon can only
   tear down by process exit. Wants `db_node_wake`/accept-with-deadline.
2. **Env var / naming** — `DOORBEARER_IROH` → neutral (we use `LOFI_NODE_IROH`);
   crate/symbol prefix `db_` reads as "Doorbearer"; fine to keep, but README
   framing ("the game") should go generic.
3. **Prebuilt distribution** — versioned release artifacts with checksums
   (in-repo prebuilts are fine for submodules, not for JSR consumers).
4. **`MAX_FRAME`/`CHUNK` tuning** are sized to game payloads (64 MiB cap is
   plenty for Jazz sync frames; just document the contract).

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
