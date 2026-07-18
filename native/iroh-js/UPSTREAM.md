# Provenance: vendored from n0-computer/iroh-ffi (iroh-js)

- **Upstream**: https://github.com/n0-computer/iroh-ffi — `iroh-js/` crate
- **Tag**: `v1.1.0`
- **Commit**: `5e451092dba0c1a09ee83ff6e5be37b1152a5c58`
- **License**: MIT OR Apache-2.0 (both vendored alongside)

## Vendored files (byte-identical to upstream unless a `// lofi-node:` marker says otherwise)

| File | Status |
|---|---|
| `src/endpoint.rs` | 2 marked edits: `pub(crate)` on the SendStream/RecvStream tuple fields (needed by `lofi_ext`) |
| `src/key.rs` | identical |
| `src/net.rs` | identical |
| `src/path.rs` | identical |
| `src/relay.rs` | identical |
| `src/ticket.rs` | identical |
| `src/watch.rs` | identical (but see Known issues) |
| `src/lib.rs` | marked edits: services module/re-export dropped; `lofi_ext` module registered |
| `Cargo.toml` | marked edit: `iroh-services` dependency dropped |
| `build.rs` | identical |
| `index.d.ts` | upstream-generated, vendored as reference; services classes listed there are NOT exported by this build |

## Dropped (not vendored)

- `src/services.rs` + `iroh-services` dependency — lofi-node does not use iroh services.
- npm packaging (`npm/`, `package.json`, yarn) — lofi-node embeds its own artifacts.
- Android glue, test/, tsconfig/typedoc.

## Not upstream

- `src/lofi_ext.rs` — Buffer-based length-prefixed framing (`writeFrame`,
  `readFrame`, `maxFrame`). Justified at gate 0: upstream `Array<number>`
  stream I/O measured 7.1 MiB/s loopback round-trip. Deletes if upstream
  grows Buffer stream I/O.

## Known issues (upstream, observed under Deno at v1.1.0)

- **watch APIs abort the process**: `watchAddr`/`watchPaths`/… call
  `tokio::spawn` from the calling JS thread (`watch.rs:35`, "no reactor
  running") and the panic cannot unwind through napi → hard abort. The TS
  layer must never call watch APIs; poll instead. Candidate upstream report.

## Update procedure (tag bump)

1. `git clone --depth 1 --branch <newtag> https://github.com/n0-computer/iroh-ffi`
2. `diff -r <clone>/iroh-js/src native/iroh-js/src` — every diff hunk must be
   either upstream's change (take it) or a `// lofi-node:` marker (keep it).
3. Re-check: does upstream now have Buffer stream I/O (delete `lofi_ext`)?
   Did the watch tokio-context bug get fixed (unblock watch APIs)?
4. Update tag/commit here; `cargo build --release`; run the full Deno fixture
   suite (`deno task test`) — it is the regression gate.
