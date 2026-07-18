// In-process test mesh: chained in-memory JazzServers with DIRECT loopback
// upstream URLs — no iroh, no dylib, no network beyond 127.0.0.1. Proves Jazz
// chaining semantics; the iroh tunnel has its own integration tests.

import { createSyncNode, type SyncNode } from "../src/node.ts";

export interface TestMesh {
  nodes: SyncNode[];
  stop(): Promise<void>;
}

export interface TestMeshOptions {
  nodes?: number;
  appId?: string;
}

/** Node 0 is the root; node i+1 uses node i as its direct upstream. All nodes
 * share one appId and secrets (they model one user's fleet). */
export async function createTestMesh(options: TestMeshOptions = {}): Promise<TestMesh> {
  const count = options.nodes ?? 2;
  const appId = options.appId ?? crypto.randomUUID();
  const backendSecret = `lofi_backend_test_${crypto.randomUUID().slice(0, 8)}`;
  const adminSecret = `lofi_admin_test_${crypto.randomUUID().slice(0, 8)}`;

  const nodes: SyncNode[] = [];
  for (let i = 0; i < count; i++) {
    nodes.push(
      await createSyncNode({
        appId,
        backendSecret,
        adminSecret,
        inMemory: true,
        mesh: "off",
        upstream: i === 0 ? "none" : { url: nodes[i - 1].url },
      }),
    );
  }
  return {
    nodes,
    stop: async () => {
      // Leaves first: stop in reverse creation order.
      for (const node of [...nodes].reverse()) await node.stop();
    },
  };
}
