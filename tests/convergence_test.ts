// The convergence fixture (lofi's exit criterion for the sync-node spike):
// two devices of ONE account (same secret, separate runtimes — lofi's
// per-device sync model) make concurrent OFFLINE edits, reconnect, and must
// both observe the union. Stages mirror lofi's convergence runner: prepare →
// concurrent offline edits → reconnect → converge.
//
// Test 1 runs against a hosted daemon when LOFI_NODE_URL / LOFI_NODE_APP_ID /
// LOFI_NODE_ADMIN_SECRET are set (else an in-memory node it spins itself).
// Test 2 is the full topology: each device on its own node, nodes paired over
// the iroh tunnel.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { createDb, schema as s } from "jazz-tools";
import { deploy } from "jazz-tools/testing";
import { definePermissions } from "jazz-tools/permissions";
import { createSyncNode, type SyncNode } from "../src/node.ts";
import { resolveIrohLib } from "../src/native/loader.ts";

const app = s.defineApp({
  notes: s.table({ text: s.string() }),
});

// Per-account data: both devices share the account, so $createdBy policies
// cover the whole multi-device fixture.
const permissions = definePermissions(app, ({ policy, session }) => [
  policy.notes.allowRead.where({ $createdBy: session.userId }),
  policy.notes.allowInsert.where({ $createdBy: session.userId }),
  policy.notes.allowUpdate
    .whereOld({ $createdBy: session.userId })
    .whereNew({ $createdBy: session.userId }),
  policy.notes.allowDelete.where({ $createdBy: session.userId }),
]);

function accountSecret(fill: number): string {
  let binary = "";
  for (const byte of new Uint8Array(32).fill(fill)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function within<T>(operation: Promise<T>, label: string, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type Db = Awaited<ReturnType<typeof createDb>>;

async function pollUntil(
  label: string,
  predicate: () => Promise<boolean>,
  milliseconds = 20_000,
): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become true within ${milliseconds}ms`);
}

/** The fixture proper: devices A and B already connected to their servers. */
async function runConvergenceFixture(deviceA: Db, deviceB: Db): Promise<void> {
  // Stage: prepare — a seeded row must reach both devices online.
  const seed = await within(
    deviceA.insert(app.notes, { text: "seed" }).wait({ tier: "global" }),
    "seed global durability",
  );
  await pollUntil(
    "device B observes the seed",
    async () => (await deviceB.all(app.notes.where({ id: seed.id }), { tier: "global" })).length === 1,
  );

  // Stage: concurrent offline edits.
  await deviceA.disconnect();
  await deviceB.disconnect();
  const fromA = deviceA.insert(app.notes, { text: "offline edit from device A" });
  const fromB = deviceB.insert(app.notes, { text: "offline edit from device B" });
  assertEquals(fromA.value.text, "offline edit from device A", "A's edit applied locally offline");
  assertEquals(fromB.value.text, "offline edit from device B", "B's edit applied locally offline");

  // Stage: reconnect.
  await deviceA.reconnect();
  await deviceB.reconnect();
  await within(fromA.wait({ tier: "global" }), "A's edit global durability");
  await within(fromB.wait({ tier: "global" }), "B's edit global durability");

  // Stage: converge — both devices observe the union.
  for (const [name, device] of [["A", deviceA], ["B", deviceB]] as const) {
    await pollUntil(`device ${name} observes all three notes`, async () => {
      const rows = await device.all(app.notes, { tier: "global" });
      const texts = new Set(rows.map((r) => r.text));
      return texts.has("seed") && texts.has("offline edit from device A") &&
        texts.has("offline edit from device B");
    });
  }
}

interface Target {
  appId: string;
  serverUrl: string;
  adminSecret: string;
}

async function connectDevices(a: Target, b: Target): Promise<[Db, Db]> {
  const secret = accountSecret(7);
  const deviceA = await createDb({
    appId: a.appId,
    serverUrl: a.serverUrl,
    secret,
    userBranch: "main",
    driver: { type: "memory" },
  });
  const deviceB = await createDb({
    appId: b.appId,
    serverUrl: b.serverUrl,
    secret,
    userBranch: "main",
    driver: { type: "memory" },
  });
  return [deviceA, deviceB];
}

Deno.test({
  name: "convergence fixture: two devices through one lofi-node",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const hostedUrl = Deno.env.get("LOFI_NODE_URL");
    let node: SyncNode | null = null;
    let target: Target;
    if (hostedUrl) {
      target = {
        serverUrl: hostedUrl,
        appId: Deno.env.get("LOFI_NODE_APP_ID")!,
        adminSecret: Deno.env.get("LOFI_NODE_ADMIN_SECRET")!,
      };
      console.log(`  → running against hosted daemon at ${hostedUrl}`);
    } else {
      node = await createSyncNode({
        appId: crypto.randomUUID(),
        backendSecret: "lofi_backend_conv",
        adminSecret: "lofi_admin_conv",
        inMemory: true,
        mesh: "off",
      });
      target = {
        serverUrl: node.url.replace(/^ws/, "http"),
        appId: node.appId,
        adminSecret: "lofi_admin_conv",
      };
    }
    await deploy({
      appId: target.appId,
      serverUrl: target.serverUrl,
      adminSecret: target.adminSecret,
      schema: app,
      permissions,
    });
    const [deviceA, deviceB] = await connectDevices(target, target);
    try {
      await runConvergenceFixture(deviceA, deviceB);
    } finally {
      await Promise.allSettled([
        within(deviceA.logout(), "device A cleanup", 3000),
        within(deviceB.logout(), "device B cleanup", 3000),
      ]);
      await node?.stop();
    }
  },
});

Deno.test({
  name: "convergence fixture: two devices on two nodes paired over iroh",
  ignore: resolveIrohLib().status !== "ok",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const shared = {
      appId: crypto.randomUUID(),
      backendSecret: "lofi_backend_conv2",
      adminSecret: "lofi_admin_conv2",
    };
    const root = await createSyncNode({ ...shared, inMemory: true });
    const leaf = await createSyncNode({
      ...shared,
      inMemory: true,
      upstream: { peer: root.ticket() },
    });
    const rootTarget: Target = {
      serverUrl: root.url.replace(/^ws/, "http"),
      appId: shared.appId,
      adminSecret: shared.adminSecret,
    };
    const leafTarget: Target = {
      serverUrl: leaf.url.replace(/^ws/, "http"),
      appId: shared.appId,
      adminSecret: shared.adminSecret,
    };
    await deploy({ ...rootTarget, schema: app, permissions });
    await deploy({ ...leafTarget, schema: app, permissions });

    // Device A on the root, device B on the leaf: convergence must cross the
    // iroh tunnel.
    const [deviceA, deviceB] = await connectDevices(rootTarget, leafTarget);
    try {
      await runConvergenceFixture(deviceA, deviceB);
    } finally {
      await Promise.allSettled([
        within(deviceA.logout(), "device A cleanup", 3000),
        within(deviceB.logout(), "device B cleanup", 3000),
      ]);
      await leaf.stop();
      await root.stop();
    }
  },
});
