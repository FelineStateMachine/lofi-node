# HTTP surface

<!-- Source: FelineStateMachine/lofi-node src/gate.ts; normative ticket semantics in the
     app-ticket contract. -->

The gate is the node's public face: it owns the public port, validates tickets, and proxies to the
loopback-only Jazz server. This page is the route-level reference for a **ticket-gated** node; in
`open` mode the same routes exist without the `/t/<secret>` prefix or scope checks.

## Routes

| Route                                 | Ticket      | Behavior                                                               |
| ------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `GET /health`                         | none        | Liveness (below). `200`, or `502` when the store is unreachable.       |
| `GET /t/<secret>/health`              | any scope   | Same liveness under a ticket base; `401` once the ticket is revoked.   |
| `GET /t/<secret>/store-status`        | any scope   | Metadata-only schema preflight (below).                                |
| `/t/<secret>/apps/<appId>/ws`         | any scope   | WebSocket sync; re-originated toward Jazz with subprotocol forwarded.  |
| `/t/<secret>/apps/<appId>/…`          | any scope   | Catalogue reads and other app routes, prefix-stripped and proxied.     |
| `/t/<secret>/apps/<appId>/admin/…`    | `provision` | Store administration; the node's admin secret is injected server-side. |
| `POST /t/<secret>/derive-sync-ticket` | `provision` | Mints a parent-linked, sync-scoped ticket (below).                     |

The `<secret>` is a 43-character base64url path segment; the gate compares digests in constant time,
strips the prefix, preserves the query string, and forwards.

## health

```jsonc
// 200 — the store answered
{ "status": "healthy" }
```

One liveness contract, every connection mode:

- **Open mode** — Jazz serves `/health` directly on the public URL.
- **Ticket mode** — the gate proxies it, unauthenticated at the top level (reachable before
  enrollment) and under any valid ticket base, so `serverUrl`-relative polling works unchanged. A
  revoked ticket gets `401` on its own base while the top level stays `200`: "node up, access gone"
  stays distinguishable from "node unreachable".
- **Peer mode** — the request rides the iroh tunnel to the peer's Jazz like any other HTTP.

Responses are cheap in all modes (one loopback hop at most) and never hang on a dead store: the gate
answers `502` when Jazz is unreachable. The client contract is composition, not a new primitive — an
app derives its single connection observable from WebSocket lifecycle events (connect, close, auth
failure) plus periodic `/health` polls, and uses it to label pending writes `offline` rather than
leaving them silently waiting. Verdict semantics for those pending writes are on the
[write verdicts](write-verdicts.md) page.

## store-status

```jsonc
// 200
{
  "v": 1,
  "appId": "…",
  "schema": {
    "deployed": true, // false → the object carries only { "deployed": false }
    "headHash": "ff85ac…", // newest stored schema hash (ordered by publishedAt)
    "permissionsHead": "0195…" // current permissions head object id, or null
  }
}

// 502 — the node is up but its store is not
{ "error": "store_unavailable" }
```

Metadata only — never schema contents, policies, or secrets. This endpoint exists so a sync-scoped
client can classify a store (most importantly `no_schema`, where writes would hang) without any
admin capability.

## derive-sync-ticket

```jsonc
// POST /t/<provision-secret>/derive-sync-ticket
// optional body: { "label": "phone (sync)" }

// 200
{ "v": 1, "id": "<ticket id>", "ticket": "lofisync1.…" }
```

The scope-down exchange: a provision-scoped secret mints a complete sync-scoped ticket linked to its
parent, so an app that enrolls one pasted provision ticket can persist transport-only credential
material and custody the provision original separately. The label defaults to
`<parent label> (sync)`. Sync-scoped and unknown secrets get the standard `401` (nothing to
enumerate); non-POST methods get `405`. Revoking the parent revokes every ticket derived from it —
live derived sockets close with `4001` like any revocation.

## Errors and close codes

| Signal                              | Meaning                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 {"error":"invalid_ticket"}`    | Unknown ticket, revoked ticket (directly or through its revoked parent), or a sync-scoped ticket on an admin route — deliberately indistinguishable. On WebSocket, the 401 **is** the upgrade response. |
| WS close `4001` (`ticket revoked`)  | The ticket was revoked mid-session; live sockets close within a couple of seconds. The app treats the sink as dead and surfaces re-enrollment.                                                          |
| WS close `1011`                     | Upstream dial or pump failure inside the gate.                                                                                                                                                          |
| `502 {"error":"store_unavailable"}` | Gate up, Jazz (or the tunnel to the root) unreachable.                                                                                                                                                  |

## Header handling

Inbound `X-Jazz-Admin-Secret` headers are **stripped unconditionally** in ticket mode; for
provision-scoped requests on admin routes the gate injects its own. Hop-by-hop headers
(`connection`, `keep-alive`, `transfer-encoding`, `upgrade`, `host`, `content-length`) are managed
by the gate in both directions; everything else passes through.
