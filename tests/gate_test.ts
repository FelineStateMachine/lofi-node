// Gate behavior against a stub upstream (no jazz, no iroh): routing,
// secret verification, prefix stripping, WS re-origination, revocation.

import { assert, assertEquals } from "@std/assert";
import { AppTicketStore, decodeAppTicket } from "../src/appticket.ts";
import { CLOSE_TICKET_REVOKED, startGate } from "../src/gate.ts";

/** Stub upstream: echoes path+search+selected headers over HTTP; echoes
 * messages and reports path/protocol over WS. */
function startStubUpstream() {
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    // Jazz-shaped catalogue routes for store-status (admin header required,
    // proving the gate injected the node's secret).
    if (url.pathname === "/apps/stub-app/schemas") {
      if (req.headers.get("x-jazz-admin-secret") !== "node-admin-secret") {
        return new Response("admin required", { status: 401 });
      }
      // Deliberately unordered `hashes`; head derives from publishedAt.
      return Response.json({
        hashes: ["hash-union", "hash-a"],
        schemas: [
          { hash: "hash-union", publishedAt: 2000 },
          { hash: "hash-a", publishedAt: 1000 },
        ],
      });
    }
    if (url.pathname === "/apps/stub-app/admin/permissions/head") {
      if (req.headers.get("x-jazz-admin-secret") !== "node-admin-secret") {
        return new Response("admin required", { status: 401 });
      }
      return Response.json({ head: "perm-head-3" });
    }
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const protocol = req.headers.get("sec-websocket-protocol")?.split(",")[0].trim();
      const { socket, response } = Deno.upgradeWebSocket(req, protocol ? { protocol } : {});
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({ hello: url.pathname + url.search, protocol: protocol ?? null }),
        );
      });
      socket.addEventListener("message", (ev) => socket.send(ev.data));
      return response;
    }
    return new Response(
      JSON.stringify({
        path: url.pathname + url.search,
        admin: req.headers.get("x-jazz-admin-secret"),
        method: req.method,
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  return {
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    close: () => server.shutdown(),
  };
}

async function withGate(
  mode: "open" | "ticket",
  fn: (ctx: {
    gateUrl: string;
    store: AppTicketStore;
    gate: ReturnType<typeof startGate>;
  }) => Promise<void>,
) {
  const upstream = startStubUpstream();
  const store = await AppTicketStore.load();
  const gate = startGate({
    port: 0,
    hostname: "127.0.0.1",
    target: () => upstream.url,
    mode,
    store,
    appId: "stub-app",
    adminSecret: "node-admin-secret",
  });
  try {
    await fn({ gateUrl: `http://127.0.0.1:${gate.port}`, store, gate });
  } finally {
    await gate.close();
    await upstream.close();
  }
}

Deno.test({
  name: "gate: valid secret strips prefix, preserves search, streams headers",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate("ticket", async ({ gateUrl, store }) => {
      const { secret } = await store.issue("t", "provision");
      const res = await fetch(
        `${gateUrl}/t/${secret}/apps/abc/admin/schema-connectivity?appId=xyz`,
        { headers: { "X-Jazz-Admin-Secret": "adm" } },
      );
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.path, "/apps/abc/admin/schema-connectivity?appId=xyz");
      assertEquals(body.admin, "node-admin-secret", "node injects its own admin secret");
    }),
});

Deno.test({
  name: "gate: /health is open; everything else 401/404",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate("ticket", async ({ gateUrl, store }) => {
      assertEquals((await (await fetch(`${gateUrl}/health`)).json()).path, "/health");
      assertEquals((await fetch(`${gateUrl}/apps/abc/ws`)).status, 404, "no ticket prefix → 404");
      const bogus = "A".repeat(43);
      assertEquals((await fetch(`${gateUrl}/t/${bogus}/apps/abc`)).status, 401);
      const { record, secret } = await store.issue();
      await store.revoke(record.id);
      assertEquals((await fetch(`${gateUrl}/t/${secret}/apps/abc`)).status, 401, "revoked → 401");
    }),
});

Deno.test({
  name: "gate: WS round-trip with subprotocol echo and path stripping",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate("ticket", async ({ gateUrl, store }) => {
      const { secret } = await store.issue();
      const ws = new WebSocket(
        `${gateUrl.replace("http", "ws")}/t/${secret}/apps/abc/ws?key=1`,
        ["jazz-sync"],
      );
      const messages: string[] = [];
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ws timeout")), 8000);
        ws.addEventListener("message", (ev) => {
          messages.push(ev.data as string);
          if (messages.length === 2) {
            clearTimeout(timer);
            resolve();
          }
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("ws error"));
        });
      });
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("close", () => reject(new Error("closed before open")));
      });
      assertEquals(ws.protocol, "jazz-sync", "subprotocol negotiated through the gate");
      ws.send("ping through gate");
      await done;
      const hello = JSON.parse(messages[0]);
      assertEquals(hello.hello, "/apps/abc/ws?key=1", "upstream saw stripped path + search");
      assertEquals(hello.protocol, "jazz-sync");
      assertEquals(messages[1], "ping through gate", "echo round-trips");
      ws.close(1000);
    }),
});

Deno.test({
  name: "gate: revocation closes live sockets with 4001",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate("ticket", async ({ gateUrl, store, gate }) => {
      const { record, secret } = await store.issue("victim");
      const ws = new WebSocket(`${gateUrl.replace("http", "ws")}/t/${secret}/apps/abc/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("close", () => reject(new Error("closed before open")));
      });
      assertEquals(gate.stats(), [{ ticketId: record.id, connections: 1 }]);

      const closed = new Promise<CloseEvent>((resolve) =>
        ws.addEventListener("close", (ev) => resolve(ev))
      );
      await store.revoke(record.id);
      const ev = await Promise.race([
        closed,
        new Promise<never>((_r, reject) =>
          setTimeout(() => reject(new Error("no revocation close within 6s")), 6000)
        ),
      ]);
      assertEquals(ev.code, CLOSE_TICKET_REVOKED);
      assertEquals(gate.stats(), []);
    }),
});

Deno.test({
  name: "gate: open mode proxies without ticket prefixes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate("open", async ({ gateUrl }) => {
      const res = await fetch(`${gateUrl}/apps/abc/schemas?x=1`);
      assertEquals((await res.json()).path, "/apps/abc/schemas?x=1");
    }),
});

Deno.test({
  name: "gate: sync scope on admin paths → 401 with the invalid-ticket shape",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate("ticket", async ({ gateUrl, store }) => {
      const { secret } = await store.issue("sync-only"); // default scope
      const res = await fetch(`${gateUrl}/t/${secret}/apps/stub-app/admin/schemas`, {
        method: "POST",
        body: "{}",
      });
      assertEquals(res.status, 401);
      assertEquals(await res.json(), { error: "invalid_ticket" }, "same shape as invalid");
      // Non-admin paths still work for the same ticket.
      const ok = await fetch(`${gateUrl}/t/${secret}/apps/abc/anything`);
      assertEquals(ok.status, 200);
      await ok.body?.cancel();
    }),
});

Deno.test({
  name: "gate: provision scope injects the node admin secret, strips inbound",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate("ticket", async ({ gateUrl, store }) => {
      const { secret } = await store.issue("admin", "provision");
      // The stub echoes the admin header it received; the client sends a FAKE
      // one which must be replaced by the node's own.
      const res = await fetch(`${gateUrl}/t/${secret}/apps/abc/echo`, {
        headers: { "X-Jazz-Admin-Secret": "client-supplied-fake" },
      });
      assertEquals((await res.json()).admin, "node-admin-secret", "injected, not forwarded");
      // Sync scope: inbound admin header is stripped, nothing injected.
      const { secret: syncSecret } = await store.issue("plain");
      const res2 = await fetch(`${gateUrl}/t/${syncSecret}/apps/abc/echo`, {
        headers: { "X-Jazz-Admin-Secret": "client-supplied-fake" },
      });
      assertEquals((await res2.json()).admin, null, "stripped for sync scope");
    }),
});

Deno.test({
  name: "gate: derive-sync-ticket mints a linked sync ticket that syncs through the gate",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate("ticket", async ({ gateUrl, store }) => {
      const { record: parent, secret } = await store.issue("laptop-admin", "provision");
      const res = await fetch(`${gateUrl}/t/${secret}/derive-sync-ticket`, {
        method: "POST",
        body: JSON.stringify({ label: "laptop" }),
      });
      assertEquals(res.status, 200);
      const body = await res.json() as { v: number; id: string; ticket: string };
      assertEquals(body.v, 1);
      const derived = decodeAppTicket(body.ticket);
      assert(derived !== null, "response carries a decodable lofisync1. ticket");
      assertEquals(derived.appId, "stub-app");
      assertEquals(derived.scope ?? "sync", "sync", "derived tickets are sync-scoped");
      assertEquals(derived.label, "laptop");
      assert(derived.url.startsWith(`${gateUrl}/t/`), "url uses the gate base");
      const record = (await store.list()).find((t) => t.id === body.id);
      assertEquals(record?.parentId, parent.id, "derived record links its parent");

      // The derived ticket round-trips through the gate for sync traffic…
      const ok = await fetch(`${derived.url}/apps/abc/echo`, {
        headers: { "X-Jazz-Admin-Secret": "client-supplied-fake" },
      });
      assertEquals(ok.status, 200);
      assertEquals((await ok.json()).admin, null, "sync scope: no admin injection");
      // …but stays locked out of admin paths and further derivation.
      const admin = await fetch(`${derived.url}/apps/stub-app/admin/schemas`, {
        method: "POST",
        body: "{}",
      });
      assertEquals(admin.status, 401);
      assertEquals(await admin.json(), { error: "invalid_ticket" });

      // Default label derives from the parent's label.
      const res2 = await fetch(`${gateUrl}/t/${secret}/derive-sync-ticket`, { method: "POST" });
      assertEquals(res2.status, 200);
      const derived2 = decodeAppTicket((await res2.json() as { ticket: string }).ticket);
      assertEquals(derived2?.label, "laptop-admin (sync)");
    }),
});

Deno.test({
  name: "gate: derive-sync-ticket 401s sync scope and unknown secrets with the invalid shape",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate("ticket", async ({ gateUrl, store }) => {
      const { secret } = await store.issue("sync-only"); // default scope
      const res = await fetch(`${gateUrl}/t/${secret}/derive-sync-ticket`, { method: "POST" });
      assertEquals(res.status, 401);
      assertEquals(await res.json(), { error: "invalid_ticket" }, "same shape as invalid");
      const bogus = "A".repeat(43);
      const unknown = await fetch(`${gateUrl}/t/${bogus}/derive-sync-ticket`, { method: "POST" });
      assertEquals(unknown.status, 401);
      assertEquals(await unknown.json(), { error: "invalid_ticket" });
    }),
});

Deno.test({
  name: "gate: revoking the parent cascades — derived ticket 401s, live sockets close 4001",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate("ticket", async ({ gateUrl, store }) => {
      const { record: parent, secret } = await store.issue("admin", "provision");
      const res = await fetch(`${gateUrl}/t/${secret}/derive-sync-ticket`, { method: "POST" });
      const { ticket } = await res.json() as { ticket: string };
      const derived = decodeAppTicket(ticket);
      assert(derived !== null);
      const before = await fetch(`${derived.url}/apps/abc/echo`);
      assertEquals(before.status, 200);
      await before.body?.cancel();

      const ws = new WebSocket(`${derived.url.replace("http", "ws")}/apps/abc/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("close", () => reject(new Error("closed before open")));
      });
      const closed = new Promise<CloseEvent>((resolve) =>
        ws.addEventListener("close", (ev) => resolve(ev))
      );

      await store.revoke(parent.id);
      const rejected = await fetch(`${derived.url}/apps/abc/echo`);
      assertEquals(rejected.status, 401, "derived ticket dies with its parent");
      assertEquals(await rejected.json(), { error: "invalid_ticket" }, "same shape as revoked");
      const ev = await Promise.race([
        closed,
        new Promise<never>((_r, reject) =>
          setTimeout(() => reject(new Error("no cascade close within 6s")), 6000)
        ),
      ]);
      assertEquals(ev.code, CLOSE_TICKET_REVOKED, "sweep closes derived sockets too");
    }),
});

Deno.test({
  name: "gate: store-status is metadata-only and any-scope",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: () =>
    withGate("ticket", async ({ gateUrl, store }) => {
      const { secret } = await store.issue("sync-only"); // sync scope suffices
      const res = await fetch(`${gateUrl}/t/${secret}/store-status`);
      assertEquals(res.status, 200);
      assertEquals(await res.json(), {
        v: 1,
        appId: "stub-app",
        schema: { deployed: true, headHash: "hash-union", permissionsHead: "perm-head-3" },
      });
      // No ticket → 404 (path shape), bogus → 401.
      const bare = await fetch(`${gateUrl}/store-status`);
      assertEquals(bare.status, 404);
      await bare.body?.cancel();
    }),
});
