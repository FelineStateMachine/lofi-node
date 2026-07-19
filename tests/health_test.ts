// The connection signal: GET /health answers in every connection mode —
// open (Jazz serves it directly), ticket (the gate proxies it, both at the
// top level and under a ticket base path), and peer (carried over the iroh
// tunnel to the node's Jazz). A failing store degrades to a non-200, never a
// hang, so clients can fold periodic health checks into a connection
// observable alongside WS lifecycle events.

import { assert, assertEquals } from "@std/assert";
import { createSyncNode } from "../src/node.ts";
import { startGate } from "../src/gate.ts";
import { AppTicketStore, decodeAppTicket } from "../src/appticket.ts";
import { loadIrohAddon } from "../src/native/addon.ts";
import { IrohNode } from "../src/iroh/node.ts";
import { startTunnelListener } from "../src/tunnel.ts";
import { resolveIrohLib } from "../src/native/loader.ts";

async function fetchHealth(base: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(new URL("/health", base));
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON error bodies stay as text
  }
  return { status: res.status, body };
}

Deno.test({
  name: "health: open mode — Jazz answers on the public URL",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const node = await createSyncNode({
      appId: crypto.randomUUID(),
      backendSecret: "lofi_backend_health_open",
      adminSecret: "lofi_admin_health_open",
      inMemory: true,
      mesh: "off",
    });
    try {
      const { status, body } = await fetchHealth(node.url.replace(/^ws/, "http"));
      assertEquals(status, 200);
      assertEquals((body as { status: string }).status, "healthy");
    } finally {
      await node.stop();
    }
  },
});

Deno.test({
  name: "health: ticket mode — unauthenticated at the top level, and under a ticket base",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const node = await createSyncNode({
      appId: crypto.randomUUID(),
      backendSecret: "lofi_backend_health_gate",
      adminSecret: "lofi_admin_health_gate",
      inMemory: true,
      mesh: "off",
      access: "ticket",
    });
    try {
      // Top level: no ticket needed — reachable before enrollment.
      const top = await fetchHealth(node.url.replace(/^ws/, "http"));
      assertEquals(top.status, 200);
      assertEquals((top.body as { status: string }).status, "healthy");

      // Under a ticket base: serverUrl-relative polling works unchanged.
      const issued = await node.issueTicket({ label: "health-probe" });
      const ticket = decodeAppTicket(issued.ticket)!;
      const relative = await fetch(`${ticket.url}/health`);
      assertEquals(relative.status, 200);
      assertEquals((await relative.json() as { status: string }).status, "healthy");

      // Revocation closes the ticket path but never the top-level signal:
      // a revoked client still distinguishes "node up, access gone" (401)
      // from "node unreachable" (network error).
      await node.revokeTicket(issued.id);
      const revoked = await fetch(`${ticket.url}/health`);
      assertEquals(revoked.status, 401);
      await revoked.body?.cancel();
      const stillUp = await fetchHealth(node.url.replace(/^ws/, "http"));
      assertEquals(stillUp.status, 200);
    } finally {
      await node.stop();
    }
  },
});

Deno.test({
  name: "health: gate degrades to 502 when the store is unreachable",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    // A dead loopback port stands in for a crashed Jazz process.
    const dead = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const deadPort = (dead.addr as Deno.NetAddr).port;
    dead.close();
    const store = await AppTicketStore.load();
    const gate = startGate({
      port: 0,
      hostname: "127.0.0.1",
      target: () => `http://127.0.0.1:${deadPort}`,
      mode: "ticket",
      store,
      appId: "health-app",
      adminSecret: "health-admin",
    });
    try {
      const res = await fetch(`${gate.url}/health`);
      assertEquals(res.status, 502, "gate up, store down → 502, not a hang");
      await res.body?.cancel();
    } finally {
      await gate.close();
    }
  },
});

Deno.test({
  name: "health: peer mode — carried over the iroh tunnel to the node's Jazz",
  ignore: resolveIrohLib().status !== "ok",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const node = await createSyncNode({
      appId: crypto.randomUUID(),
      backendSecret: "lofi_backend_health_peer",
      adminSecret: "lofi_admin_health_peer",
      inMemory: true,
    });
    const addon = await loadIrohAddon();
    const dialer = await IrohNode.open(addon, crypto.getRandomValues(new Uint8Array(32)));
    const listener = startTunnelListener(dialer, node.ticket());
    try {
      const { status, body } = await fetchHealth(`http://127.0.0.1:${listener.port}`);
      assertEquals(status, 200);
      assertEquals((body as { status: string }).status, "healthy");
      assert(listener.stats().length >= 0, "tunnel stats observable");
    } finally {
      await listener.close();
      await dialer.close();
      await node.stop();
    }
  },
});
