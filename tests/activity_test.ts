// Connection observability: gate stats carry last-seen, the activity sink is
// notified on authenticated traffic, and the sidecar round-trips for the CLI.

import { assert, assertEquals } from "@std/assert";
import { AppTicketStore } from "../src/appticket.ts";
import { startGate } from "../src/gate.ts";
import { readTicketActivity, TicketActivity } from "../src/ticket-activity.ts";

function startStubUpstream() {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    () => new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  return {
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    close: () => server.shutdown(),
  };
}

Deno.test("authenticated traffic stamps gate stats and the activity sink", async () => {
  const upstream = startStubUpstream();
  const store = await AppTicketStore.load();
  const noted: string[] = [];
  const gate = startGate({
    port: 0,
    hostname: "127.0.0.1",
    target: () => upstream.url,
    mode: "ticket",
    store,
    appId: "stub-app",
    adminSecret: "node-admin-secret",
    activity: { note: (ticketId) => noted.push(ticketId) },
  });
  try {
    const issued = await store.issue("phone");
    const before = gate.stats();
    assertEquals(before.length, 0);

    const res = await fetch(`http://127.0.0.1:${gate.port}/t/${issued.secret}/echo`);
    assertEquals(res.status, 200);
    await res.body?.cancel();

    const after = gate.stats();
    const entry = after.find((e) => e.ticketId === issued.record.id);
    assert(entry, "stats must include the seen ticket");
    assertEquals(entry.connections, 0);
    assert(typeof entry.lastSeenAt === "string", "lastSeenAt must be stamped");
    assert(noted.includes(issued.record.id), "the activity sink must be notified");

    // An invalid secret stamps nothing.
    const bad = await fetch(`http://127.0.0.1:${gate.port}/t/${"A".repeat(43)}/echo`);
    assertEquals(bad.status, 401);
    await bad.body?.cancel();
    assertEquals(gate.stats().length, 1);
  } finally {
    await gate.close();
    await upstream.close();
  }
});

Deno.test("the activity sidecar persists and reloads", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const activity = await TicketActivity.load(dir);
    assertEquals(activity.lastSeen("t1"), undefined);
    activity.note("t1");
    const stamped = activity.lastSeen("t1");
    assert(typeof stamped === "string", "note must stamp in memory immediately");
    await activity.flush();

    const viaCli = await readTicketActivity(dir);
    assertEquals(viaCli.get("t1"), stamped);

    const reloaded = await TicketActivity.load(dir);
    assertEquals(reloaded.lastSeen("t1"), stamped, "restarts keep last-seen");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a missing sidecar reads as empty", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const viaCli = await readTicketActivity(dir);
    assertEquals(viaCli.size, 0);
    const memoryOnly = await TicketActivity.load();
    memoryOnly.note("t1");
    await memoryOnly.flush();
    assert(memoryOnly.lastSeen("t1") !== undefined, "memory-only activity still tracks");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
