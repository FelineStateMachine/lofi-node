# Hosting a lofi app on your own sync node

lofi-node is the first-class way to self-host the sync backend for a
[lofi](https://github.com/FelineStateMachine/lofi) app: the browser keeps speaking Jazz's protocol
(`adapter: "jazz"` untouched); only the server URL changes. This walkthrough was validated end to
end against lofi's reference app (`apps/reference`) with real Chromium clients.

## 1. Host a node

```sh
lofi-node init --dir ./data --port 4802    # prints the app id (a UUID)
lofi-node start --dir ./data               # Jazz URL + pairing ticket
```

`data/config.json` holds the app id and the admin secret you'll need next.

## 2. Deploy the app's schema to the node

A lofi app's schema must be published to the sync server it uses (the managed dev server does this
automatically; a self-hosted node needs it once — and on every schema change). From the app
directory, use the same schema-project deploy the lofi dev flow uses:

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
JAZZ_APP_ID=<app id> JAZZ_SERVER_URL=http://127.0.0.1:4802 deno task build
deno task preview
```

`JAZZ_SERVER_URL` must be http(s) — lofi's preflight rejects ws URLs; the browser client derives the
WebSocket endpoint itself (`/apps/<uuid>/ws`). For LAN/production use an https reverse proxy in
front of the node's port; installed PWAs require a secure origin.

## Validation status (2026-07-18, jazz-tools 2.0.0-alpha.53)

- Reference app **builds, boots, and serves** against a lofi-node backend; two real Chromium clients
  (lofi's `createTwoClientFixture`) load the app, hydrate the store, go offline, and edit
  independently.
- lofi's opt-in browser convergence gate (`tests/convergence_e2e_test.ts`) currently fails at the
  convergence stage with `CatalogueWriteDenied` from the server when the second (cloned identity)
  client reconnects — **identically against lofi-node and against lofi's own managed dev server**
  (controlled experiment, same error, same catalogue object id). lofi-node has exact behavior parity
  with the first-party local server; the denial is a jazz-tools alpha.53 local-server behavior,
  upstream of this project. Headless two-client convergence (jazz-tools `createDb` clients, same
  account, concurrent offline edits) passes against lofi-node — see `tests/convergence_test.ts`.

## Pairing two homes

On the second node: `lofi-node pair <ticket from the first>` (or `SyncNode.pair(ticket)` at
runtime). Catalogue reads/writes and sync then flow to the peer over iroh — deploying the schema to
either node lands on the root through the tunnel's HTTP proxy.
