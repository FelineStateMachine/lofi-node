# App-connect tickets — the contract

This is the format and semantics the lofi app side implements against. An app ticket is the
credential a user hands to a lofi app so it syncs against their self-hosted node. It is distinct
from the **node-pairing ticket** (the `endpoint…` string used by `lofi-node pair`).

## Ticket string

```
lofisync1.<base64url(JSON, no padding)>
```

```jsonc
{
  "v": 1,
  "appId": "cfe52e44-7a59-4232-8dbb-bf53f27aeed6",
  "url": "http://192.168.1.10:4802/t/<secret>", // ← the app's serverUrl, verbatim
  "scope": "provision", // optional: "sync" (default when absent) | "provision"
  "label": "phone", // optional, user-facing
  "node": "endpoint…" // optional: the node's iroh EndpointTicket (forward compat)
}
```

Parsers must treat unknown OPTIONAL fields as forward-compatible additions and an absent `scope` as
`"sync"` — every pre-scope ticket keeps meaning transport-only. Machine-readable conformance
fixtures: [fixtures/app-ticket-fixtures.json](fixtures/app-ticket-fixtures.json).

- `<secret>` is 32 random bytes base64url (43 chars, alphabet `[A-Za-z0-9_-]`) — safe as a URL path
  segment with no encoding.
- The node stores only the SHA-256 digest of the secret; the ticket string is displayable **once**,
  at issuance.

## Why the secret lives in the URL path

jazz clients preserve a base path in `serverUrl` (`appScopedUrl`) and reject query params. With
`serverUrl = <ticket.url>`, every request the client makes carries the secret with **zero client
changes**:

- sync WebSocket → `…/t/<secret>/apps/<appId>/ws`
- catalogue reads → `…/t/<secret>/apps/<appId>/schemas`, `schema/<hash>`
- admin (deploys) → `…/t/<secret>/apps/<appId>/admin/…` (Jazz's `X-Jazz-Admin-Secret` is still
  required on top — the ticket gates transport, the admin secret gates administration)

The node's access gate validates the secret (timing-safe, digest vs digest), strips the
`/t/<secret>` prefix, and proxies to the internal Jazz server (which binds loopback-only).

## Scopes: sync vs provision

- **`sync`** (default): transport only. Admin/catalogue-mutating routes (`…/apps/<id>/admin/…`)
  answer the SAME `401 {"error":"invalid_ticket"}` as an unknown secret — nothing to enumerate. This
  is what lofi#109 calls "enrolling a ticket attaches transport only and never mutates the store."
- **`provision`**: a strict superset of sync — everything above PLUS store administration. For
  provision-scoped HTTP requests the gate **injects the node's `X-Jazz-Admin-Secret` itself** (on
  `/admin/*` and on catalogue reads like `/schemas` and `/schema/<hash>`, which the merge-deploy
  flow needs to fetch the stored head schema verbatim). The admin secret therefore never leaves the
  node and never transits the client: a provisioning client passes any placeholder admin secret to
  jazz-tools `deploy` — the gate strips inbound `X-Jazz-Admin-Secret` headers in ticket mode and
  substitutes its own. Possession of a provision ticket IS the store-administration opt-in. Issue
  one per provisioning context (`ticket issue --provision --label
  laptop-admin`), not per device.

Revocation semantics are identical for both scopes (401 / WS 4001).

## Scope-down exchange (derive a sync ticket)

A provision ticket can mint a **derived sync ticket** from itself, so a user who pastes a single
provision ticket ends up with two capability tiers: the app persists the derived sync ticket at rest
and keeps the provision ticket sealed (passkey-PRF) or memory-only.

```
POST <ticket.url>/derive-sync-ticket
```

- **Auth**: the provision-scoped secret in the URL path, like every gated request. A sync-scoped or
  unknown secret gets the same `401 {"error":"invalid_ticket"}` as any unauthorized request —
  nothing to enumerate. Non-POST methods on a provision ticket get `405`.
- **Request body** (optional): `{ "label": "laptop" }`. Absent, the label defaults to
  `<parent label> (sync)` (parent id when unlabelled).
- **Response**: `200 {"v": 1, "id": "<ticket id>", "ticket": "lofisync1.…"}` — a complete
  sync-scoped ticket string. Its `url` uses the node's configured public base (`--public-url`),
  exactly like CLI-issued tickets; the secret is embedded once and never stored.

The derived ticket's record carries the parent's id, and **revocation cascades**: once the parent is
revoked (or its record removed), every ticket derived from it fails verification exactly like a
revoked ticket — 401 on new requests, close code 4001 for live WebSockets. Revoking a derived ticket
alone leaves its parent untouched. Derived tickets are always sync scope, so derivation cannot
escalate and effective chains are one level deep; the parent check still walks the whole lineage.
`lofi-node ticket list` shows derived tickets as `[from <parent id>]` and reports them REVOKED once
their lineage is.

## Store-status preflight

Against a store with **no deployed schema, client writes hang indefinitely** (lofi#109's pinned
failure surface) — so a sync-only client needs a preflight it can reach without the admin secret.
Any valid ticket (sync scope included) may call:

```
GET <ticket.url>/store-status
```

```jsonc
{
  "v": 1,
  "appId": "…",
  "schema": {
    "deployed": true, // false → { "deployed": false } only
    "headHash": "ff85ac…", // newest stored schema hash
    "permissionsHead": "0195…" // current permissions head object id, or null
  }
}
```

Metadata only — never schema contents, never policies, never secrets. The node answers it itself (it
holds the admin secret and queries its loopback Jazz). lofi's store classifier maps this to
`no_schema` / hash-comparison states instead of hanging; `502 {"error":"store_unavailable"}` means
the node's Jazz is unreachable. On open-mode (ungated) nodes this endpoint does not exist — dev
setups hold the admin secret and can query Jazz directly.

## Enrollment flow (app side)

1. User pastes/scans the ticket string; app parses it (`decodeAppTicket` in `@nzip/lofi-node`
   mirrors the validation: prefix, `v: 1`, http(s) URL with a `/t/<43-char-secret>` path).
2. A `provision`-scoped ticket is split before anything persists: the app calls the scope-down
   exchange (above) and declares the derived sync ticket as its sink; the provision original is held
   in memory and, on PRF-capable devices, sealed behind the user's passkey — otherwise the user's
   password manager keeps the durable copy. Against a node without the exchange, the ticket enrolls
   as pasted.
3. The declared sink persists only as a sealed envelope under a device-bound key (localStorage key
   `lofi:data-sink:<appId>`; nothing bearer-shaped is stored in cleartext). Boot opens it silently —
   no ceremony — and uses `ticket.url` as the runtime `serverUrl`. Unlocking sealed provision
   capability for an admin operation is a user-verifying passkey ceremony.
4. `ticket.appId` should match the app's own id; refuse enrollment otherwise.

## Revocation semantics

- Unknown **and** revoked secrets both get `401 {"error":"invalid_ticket"}` — indistinguishable to
  probers, on HTTP and on the WS upgrade (the 401 _is_ the upgrade response).
- A ticket revoked mid-session closes its live WebSockets with close code **4001**
  (`ticket revoked`) within a couple of seconds.
- On 401/4001 the app should treat the stored ticket as dead and surface re-enrollment (do not
  silently retry forever).
- `GET /health` (no secret) is open — safe for liveness probes.

## Security notes

- The ticket is a **bearer credential** (256-bit entropy). Anyone holding it can sync as an
  authorized transport peer; identity/permissions remain Jazz's local-first layer on top.
- Plain http is acceptable on a trusted LAN; anything beyond that should front the gate with TLS
  (the URL scheme in the ticket may be `https`). Installed PWAs generally require a secure origin
  anyway.
- Issue one ticket per device/context (`--label phone`) so revocation is scoped.
