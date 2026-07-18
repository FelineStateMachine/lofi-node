// Integration: the full daemon topology — two real JazzServers, the leaf's
// upstream election `{ peer: ticket }` carried over the iroh tunnel to the
// root. Proves createSyncNode wiring end to end; whether Jazz's upstream WS
// client dials eagerly at start or lazily on first sync traffic is Jazz's
// business — here we assert the topology comes up and both servers stay
// healthy with the tunnel in the path.

import { assert, assertEquals } from "jsr:@std/assert@1";
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

    await leaf.stop();
    await root.stop();
  },
});
