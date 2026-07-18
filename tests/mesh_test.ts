// Integration: JazzServer boots under Deno via jazz-napi, serves a WebSocket,
// and chains upstream (createTestMesh). Convergence assertions with a real
// Jazz client come next (lofi's Playwright fixtures pointed at node URLs).

import { assert, assertEquals } from "@std/assert";
import { createTestMesh } from "../testing/mod.ts";

async function healthy(wsUrl: string): Promise<boolean> {
  const httpUrl = wsUrl.replace(/^ws/, "http");
  try {
    const res = await fetch(new URL("/health", httpUrl));
    const body = await res.json();
    return res.status === 200 && body.status === "healthy";
  } catch {
    return false;
  }
}

Deno.test({
  name: "two in-memory JazzServers boot and chain upstream",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const mesh = await createTestMesh({ nodes: 2 });
    try {
      assertEquals(mesh.nodes.length, 2);
      assert(mesh.nodes[0].url.startsWith("ws://"), `root url: ${mesh.nodes[0].url}`);
      const status = mesh.nodes[1].status();
      assertEquals(status.upstream, { url: mesh.nodes[0].url });
      assertEquals(status.mesh.state, "off");
      assert(await healthy(mesh.nodes[0].url), "root node reports healthy");
      assert(await healthy(mesh.nodes[1].url), "leaf node reports healthy");
    } finally {
      await mesh.stop();
    }
  },
});
