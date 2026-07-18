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
  "label": "phone", // optional, user-facing
  "node": "endpoint…" // optional: the node's iroh
  //   EndpointTicket (forward
  //   compat; unused by browsers)
}
```

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

## Enrollment flow (app side)

1. User pastes/scans the ticket string; app parses it (`decodeAppTicket` in `@nzip/lofi-node`
   mirrors the validation: prefix, `v: 1`, http(s) URL with a `/t/<43-char-secret>` path).
2. App encrypts the ticket with the passkey-derived at-rest key (lofi `package/runtime/auth.ts`:
   `derivePrfSecret` → `deriveAtRestKey` → `encryptAtRest`) and stores the blob in localStorage
   (suggested key: `lofi:sync-location:<appId>`).
3. On boot, after the user unlocks with their passkey: decrypt, use `ticket.url` as the runtime
   `serverUrl` override. The decrypted local data therefore reveals _location + access_ for the
   user's lofi data.
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
