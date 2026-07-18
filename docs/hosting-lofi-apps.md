# Hosting a lofi app on your own sync node

lofi-node is the first-class way to self-host the sync backend for a
[lofi](https://github.com/FelineStateMachine/lofi) app: the browser keeps speaking Jazz's protocol
(`adapter: "jazz"` untouched); only the server URL changes. This walkthrough was validated end to
end against lofi's reference app (`apps/reference`) with real Chromium clients.

## 1. Host a node

Install once (`deno install -g -A -n lofi-node jsr:@nzip/lofi-node/cli`), run ad hoc with
`dx -A jsr:@nzip/lofi-node/cli …`, or download a compiled binary from the GitHub releases. Then:

```sh
lofi-node init --dir ./data --port 4802 --public-url http://192.168.1.10:4802
lofi-node start --dir ./data
```

New inits are **ticket-gated**: only requests carrying an issued app-ticket secret reach Jazz (the
embedded Jazz server binds loopback-only; lofi-node's access gate owns the public port). `--open`
opts out for dev setups. `data/config.json` holds the app id and the admin secret you'll need below.

### Storage choice

`--storage-path /mnt/nas/lofi` puts the SQLite store on any mounted location (NAS, synced volume);
`--memory` keeps everything ephemeral. The path is probed writable at boot — an unwritable location
fails fast by name. jazz-napi supports exactly SQLite-directory and memory today; for cloud off-site
durability, replicate the SQLite file (Litestream-style to S3, or a snapshotting volume). The
`storage.type` discriminator in config is the seam future providers slot into.

### Issue an app ticket

```sh
lofi-node ticket issue --dir ./data --label phone
# → lofisync1.eyJ2IjoxLCJhcHBJZCI6…   (shown once; secret is never stored)
lofi-node ticket list --dir ./data
lofi-node ticket revoke <id> --dir ./data   # live sockets close with 4001
```

The user pastes the ticket into their lofi app (tell them to let their password manager save it —
the secret is shown once and the node keeps only a hash). The app never stores a ticket in
cleartext: a sync ticket persists as a sealed record under a device-bound key and its URL becomes
the sync server; a provision ticket is split first through the scope-down exchange — the app stores
a derived sync ticket and keeps the provision original passkey-sealed or memory-only. Format and
app-side flow: [app-ticket.md](app-ticket.md).

## 2. Get the app's schema into the store

A store with no deployed schema is unusable — client writes hang (preflight with
`GET <ticket.url>/store-status`, see [app-ticket.md](app-ticket.md)). Two paths publish a schema:

**Primary — runtime provisioning via a provision ticket** (the lofi#109 opt-in flow): issue
`lofi-node ticket issue --provision --label app-setup` and hand it to the app. On enrollment the app
splits it through the scope-down exchange (everyday transport rides a derived sync ticket; admin
capability unlocks through a passkey ceremony when provisioning actually runs). The app (or any
jazz-tools `deploy` caller) uses the ticket URL as `serverUrl` with a placeholder admin secret — the
gate strips inbound admin headers and injects the node's own for provision-scoped requests, so the
real secret never leaves the node. Slice-by-slice merge deploys (`createTables` migrations, union
permissions) flow through the same ticket; old-hash clients keep syncing across a merge.

**Fallback — operator-side deploy from the app directory**, using the same schema-project deploy the
lofi dev flow uses (also easiest via a provision ticket URL as `serverUrl`; the admin secret
argument can then be a placeholder):

```ts
// deploy-schema.ts (run: deno run -A deploy-schema.ts)
import { deploy } from "./node_modules/.deno/jazz-tools@2.0.0-alpha.53/node_modules/jazz-tools/dist/dev/catalogue-project.js";
await deploy({
  serverUrl: "http://127.0.0.1:4802",
  appId: "<app id from config.json>",
  adminSecret: "<admin secret from config.json>",
  schemaDir: "./src",
});
```

> The schemaDir-project deploy is not yet a public jazz-tools export — a `lofi-node deploy` CLI verb
> wrapping this is a natural follow-up once jazz-tools exposes it (or lofi's provision command grows
> a self-host mode).

## 3. Build the app against the node

```sh
JAZZ_APP_ID=<app id> JAZZ_SERVER_URL=<ticket url> deno task build
deno task preview
```

`JAZZ_SERVER_URL` must be http(s) — lofi's preflight rejects ws URLs; the browser client derives the
WebSocket endpoint itself (`…/apps/<uuid>/ws`, preserving the ticket's `/t/<secret>` base path). On
an open-mode node use the node URL directly. Beyond a trusted LAN, front the gate with TLS;
installed PWAs require a secure origin. (Once lofi ships its runtime serverUrl override, the
build-time env becomes unnecessary — the app enrolls the ticket at runtime instead; see
[app-ticket.md](app-ticket.md).)

## Validation status (2026-07-18, jazz-tools 2.0.0-alpha.53)

- Reference app **builds, boots, and serves** against a lofi-node backend; two real Chromium clients
  (lofi's `createTwoClientFixture`) load the app, hydrate the store, go offline, and edit
  independently.
- lofi's opt-in browser convergence gate (`tests/convergence_e2e_test.ts`) **passes against
  lofi-node**: two real Chromium clients with the backup-and-sync election performed, concurrent
  offline edits, reconnection, full bidirectional convergence — identical results against lofi's own
  managed dev server. (An earlier version of this section reported the gate failing with
  `CatalogueWriteDenied`; that diagnosis was wrong. The gate was not electing sync, so both clients
  ran local-only by design, and the warning — which every browser client logs once at boot on every
  server, converging or not — was misattributed as the cause. lofi's decision record
  `docs/decisions/0002-convergence-verdict.md` carries the evidence.) Headless two-client
  convergence passes as before — see `tests/convergence_test.ts`.

## Pairing two homes

On the second node: `lofi-node pair <ticket from the first>` (or `SyncNode.pair(ticket)` at
runtime). Catalogue reads/writes and sync then flow to the peer over iroh — deploying the schema to
either node lands on the root through the tunnel's HTTP proxy.
