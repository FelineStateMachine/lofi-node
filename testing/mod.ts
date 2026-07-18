/**
 * In-process test helpers for lofi-node consumers.
 *
 * {@link createTestMesh} chains in-memory Jazz servers with direct loopback
 * upstream URLs — no iroh, no native addon, no network beyond 127.0.0.1 — so
 * app test suites can exercise multi-node sync topologies cheaply:
 *
 * ```ts
 * import { createTestMesh } from "@nzip/lofi-node/testing";
 *
 * const mesh = await createTestMesh({ nodes: 2 });
 * // point two clients at mesh.nodes[0].url / mesh.nodes[1].url …
 * await mesh.stop();
 * ```
 *
 * @module
 */

import { createSyncNode, type SyncNode } from "../src/node.ts";

/** A running in-process mesh; stop() tears nodes down leaves-first. */
export interface TestMesh {
  /** Node 0 is the root; node i+1 uses node i as its direct upstream. */
  nodes: SyncNode[];
  /** Stop all nodes in reverse creation order. */
  stop(): Promise<void>;
}

/** Options for {@link createTestMesh}. */
export interface TestMeshOptions {
  /** How many chained nodes to start (default 2). */
  nodes?: number;
  /** Jazz app id shared by the whole mesh (default: a random UUID). */
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
