// Gate behavior against a stub upstream (no jazz, no iroh): routing,
// secret verification, prefix stripping, WS re-origination, revocation.

import { assert, assertEquals } from "@std/assert";
import { AppTicketStore } from "../src/appticket.ts";
import { CLOSE_TICKET_REVOKED, startGate } from "../src/gate.ts";

/** Stub upstream: echoes path+search+selected headers over HTTP; echoes
 * messages and reports path/protocol over WS. */
function startStubUpstream() {
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
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
      const { secret } = await store.issue("t");
      const res = await fetch(
        `${gateUrl}/t/${secret}/apps/abc/admin/schema-connectivity?appId=xyz`,
        { headers: { "X-Jazz-Admin-Secret": "adm" } },
      );
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(body.path, "/apps/abc/admin/schema-connectivity?appId=xyz");
      assertEquals(body.admin, "adm", "admin header forwarded for Jazz's own enforcement");
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
