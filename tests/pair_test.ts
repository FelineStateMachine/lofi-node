// Integration: the full daemon topology — two real JazzServers, the leaf's
// upstream election `{ peer: ticket }` carried over the iroh tunnel to the
// root. Proves createSyncNode wiring end to end; whether Jazz's upstream WS
// client dials eagerly at start or lazily on first sync traffic is Jazz's
// business — here we assert the topology comes up and both servers stay
// healthy with the tunnel in the path.

import { assert, assertEquals } from "@std/assert";
import { createSyncNode } from "../src/node.ts";
import { resolveIrohLib } from "../src/native/loader.ts";

const available = resolveIrohLib().status === "ok";

async function healthy(wsUrl: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/health", wsUrl.replace(/^ws/, "http")));
    return res.status === 200 && (await res.json()).status === "healthy";
  } catch {
    return false;
  }
}

Deno.test({
  name: "two nodes pair over iroh: leaf upstream tunnels to root",
  ignore: !available,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const shared = {
      appId: crypto.randomUUID(),
      backendSecret: "lofi_backend_pairtest",
      adminSecret: "lofi_admin_pairtest",
    };

    const root = await createSyncNode({ ...shared, inMemory: true });
    const rootStatus = root.status();
    assertEquals(rootStatus.mesh.state, "up", "root mesh up");

    const leaf = await createSyncNode({
      ...shared,
      inMemory: true,
      upstream: { peer: root.ticket() },
    });
    const leafStatus = leaf.status();
    assertEquals(leafStatus.mesh.state, "up", "leaf mesh up");
    assert("peer" in (leafStatus.upstream as object), "leaf elected peer upstream");

    // Give Jazz's upstream client a moment to dial through the tunnel.
    await new Promise((r) => setTimeout(r, 3000));

    assert(await healthy(root.url), "root healthy with tunnel in path");
    assert(await healthy(leaf.url), "leaf healthy with tunnel in path");

    // Observability: the live upstream link shows up in both nodes' status.
    const leafMesh = leaf.status().mesh;
    const rootMesh = root.status().mesh;
    assert(leafMesh.state === "up" && rootMesh.state === "up", "both meshes up");
    assert(
      leafMesh.connections.some((c) => c.direction === "out" && c.paths >= 1),
      `leaf shows a live outbound tunnel conn: ${JSON.stringify(leafMesh.connections)}`,
    );
    assert(
      rootMesh.connections.some((c) => c.direction === "in"),
      `root shows a live inbound tunnel conn: ${JSON.stringify(rootMesh.connections)}`,
    );

    await leaf.stop();
    await root.stop();
  },
});

Deno.test({
  name: "runtime pair(): late upstream election without losing the port",
  ignore: !available,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const shared = {
      appId: crypto.randomUUID(),
      backendSecret: "lofi_backend_latepair",
      adminSecret: "lofi_admin_latepair",
    };
    const root = await createSyncNode({ ...shared, inMemory: true });
    const leaf = await createSyncNode({ ...shared, inMemory: true }); // unpaired
    const portBefore = leaf.port;
    assertEquals(leaf.status().upstream, "none");

    await leaf.pair(root.ticket());

    assertEquals(leaf.port, portBefore, "port survives re-pairing");
    assert("peer" in (leaf.status().upstream as object), "upstream re-elected");
    assert(await healthy(leaf.url), "leaf healthy on the same URL after pair");

    // Jazz eagerly dials the new upstream through the tunnel.
    await new Promise((r) => setTimeout(r, 3000));
    const rootMesh = root.status().mesh;
    assert(
      rootMesh.state === "up" && rootMesh.connections.some((c) => c.direction === "in"),
      "root sees the newly paired leaf's tunnel",
    );

    await leaf.stop();
    await root.stop();
  },
});

Deno.test({
  name: "ticket mode: gate URL and port survive runtime pair()",
  ignore: !available,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const shared = {
      appId: crypto.randomUUID(),
      backendSecret: "lofi_backend_gatepair",
      adminSecret: "lofi_admin_gatepair",
    };
    const root = await createSyncNode({ ...shared, inMemory: true });
    const leaf = await createSyncNode({ ...shared, inMemory: true, access: "ticket" });
    const gateUrlBefore = leaf.url;
    const gatePortBefore = leaf.port;
    const internalBefore = leaf.status().jazz.port;
    assert(gatePortBefore !== internalBefore, "gate and internal jazz are distinct ports");

    await leaf.pair(root.ticket());

    assertEquals(leaf.url, gateUrlBefore, "public gate URL unchanged across pair()");
    assertEquals(leaf.port, gatePortBefore, "public gate port unchanged across pair()");
    // The gate still reaches the (restarted) internal Jazz.
    const res = await fetch(`${gateUrlBefore.replace(/^ws/, "http")}/health`);
    assertEquals((await res.json()).status, "healthy", "gate → restarted jazz healthy");

    await leaf.stop();
    await root.stop();
  },
});
