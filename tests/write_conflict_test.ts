// Behavioral coverage for the two batch-fate codes beyond permission_denied
// that the pinned alpha's server can emit (see src/verdict.ts for the full
// code-space audit):
//
// - `transaction_conflict`: two devices stage a transactional update to the
//   same row from the same visible frontier; the authority accepts the first
//   seal and rejects the second ("row visible parent changed since transaction
//   write was staged"). The fate is final — the engine does not rebase or
//   retry the losing batch — and deterministic across reconnects.
// - `permissions_head_missing`: a store whose schema is deployed without a
//   permissions head fails closed and rejects every write, on both verdict
//   surfaces, with the batch correlated. Publishing permissions afterwards
//   does not revisit the persisted fate; only new batches see the new head.
//
// `invalid_batch_submission` has no test here because it is unreachable from
// the public API: every trigger is a sealed-envelope invariant the client
// runtime itself computes, and the one author-reachable shape — committing an
// empty transaction — throws synchronously before any batch exists (pinned
// below).
//
// Scope note: the conflict is staged ONLINE. A transactional batch committed
// while offline does not re-submit its seal on reconnect at the pinned alpha,
// so the authority never adjudicates it — the write stays unapplied and
// `wait()` fails with a runtime error rather than a verdict. That degradation
// is an upstream client defect at the pin, not a settlement contract, so it
// is documented here rather than pinned as a test.
//
// Schemas are defined INSIDE the test fns: jazz registers schemas process-
// globally at definition time, and module-level definitions would clobber
// other test files' declared hashes.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { createDb, schema as s } from "jazz-tools";
import { deploy } from "jazz-tools/testing";
import { definePermissions } from "jazz-tools/permissions";
import { createSyncNode } from "../src/node.ts";
import { classifyMutationError } from "../src/verdict.ts";

interface MutationErrorEvent {
  code: string;
  reason: string;
  batch: {
    batchId: string;
    mode: string;
    sealed: boolean;
    latestSettlement: { kind: string; batchId: string; code?: string; reason?: string } | null;
  };
}

interface Rejection {
  outcome: "rejected";
  name?: string;
  batchId?: string;
  code?: string;
  reason?: string;
}

type Verdict = Rejection | { outcome: "settled" };

function accountSecret(fill: number): string {
  let binary = "";
  for (const byte of new Uint8Array(32).fill(fill)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function within<T>(operation: Promise<T>, label: string, milliseconds = 20_000): Promise<T> {
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

/** Settle a write handle into a plain verdict object. */
function settle(handle: { wait(options: { tier: "global" }): Promise<unknown> }): Promise<Verdict> {
  return handle.wait({ tier: "global" }).then(
    (): Verdict => ({ outcome: "settled" }),
    (e: Error & Partial<Rejection>): Verdict => ({
      outcome: "rejected",
      name: e.name,
      batchId: e.batchId,
      code: e.code,
      reason: e.reason,
    }),
  );
}

async function pollUntil(
  label: string,
  predicate: () => Promise<boolean>,
  milliseconds = 20_000,
): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} did not become true within ${milliseconds}ms`);
}

Deno.test({
  name:
    "write verdict: a losing concurrent transaction settles transaction_conflict, final and deterministic",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tables = { conflict__rows: s.table({ text: s.string() }) };
    const app = s.defineApp(tables);
    const permissions = definePermissions(app, ({ policy, session }) => [
      policy.conflict__rows.allowRead.where({ $createdBy: session.userId }),
      policy.conflict__rows.allowInsert.where({ $createdBy: session.userId }),
      policy.conflict__rows.allowUpdate
        .whereOld({ $createdBy: session.userId })
        .whereNew({ $createdBy: session.userId }),
    ]);

    const node = await createSyncNode({
      appId: crypto.randomUUID(),
      backendSecret: "lofi_backend_conflict",
      adminSecret: "lofi_admin_conflict",
      inMemory: true,
      mesh: "off",
    });
    const target = {
      appId: node.appId,
      serverUrl: node.url.replace(/^ws/, "http"),
      adminSecret: "lofi_admin_conflict",
    };
    try {
      await deploy({ ...target, schema: app, permissions });
      const secret = accountSecret(34);
      const connect = () =>
        createDb({
          appId: node.appId,
          serverUrl: target.serverUrl,
          secret,
          userBranch: "main",
          driver: { type: "memory" },
        });
      const deviceA = await connect();
      const deviceB = await connect();
      try {
        const seed = await within(
          deviceA.insert(app.conflict__rows, { text: "seed" }).wait({ tier: "global" }),
          "seed write settles",
        );
        await pollUntil(
          "device B observes the seed",
          async () =>
            (await deviceB.all(app.conflict__rows.where({ id: seed.id }), { tier: "global" }))
              .length === 1,
        );

        // Both devices stage a transactional update to the same row from the
        // same visible frontier, while connected.
        const txA = deviceA.beginTransaction();
        txA.update(app.conflict__rows, seed.id, { text: "A wins" });
        const txB = deviceB.beginTransaction();
        txB.update(app.conflict__rows, seed.id, { text: "B loses" });

        // A's seal reaches the authority first and advances the frontier.
        const handleA = txA.commit();
        assertEquals((await within(settle(handleA), "A's transaction settles")).outcome, "settled");

        // B's seal validates against a frontier that has moved.
        const handleB = txB.commit();
        assert(handleA.batchId !== handleB.batchId, "distinct batches");
        const verdict = await within(settle(handleB), "B's transaction settles");
        assertEquals(verdict.outcome, "rejected");
        const rejection = verdict as Rejection;
        assertEquals(rejection.name, "PersistedWriteRejectedError");
        assertEquals(rejection.code, "transaction_conflict");
        assertEquals(rejection.batchId, handleB.batchId, "verdict correlates to the losing batch");
        assert(rejection.reason && rejection.reason.length > 0, "reason present (diagnostics)");
        assertEquals(classifyMutationError(rejection.code!), "permanent");

        // The fate is final and deterministic: re-waiting across a reconnect
        // re-derives the same code, and the engine never rebases or retries
        // the losing write — the row converges to the winner everywhere.
        await deviceB.disconnect();
        await deviceB.reconnect();
        const again = await within(settle(handleB), "re-derived verdict after reconnect");
        assertEquals((again as Rejection).code, "transaction_conflict");
        assertEquals((again as Rejection).batchId, handleB.batchId);
        await pollUntil("device B converges on the winning write", async () => {
          const rows = await deviceB.all(app.conflict__rows.where({ id: seed.id }), {
            tier: "global",
          });
          return rows.length === 1 && rows[0].text === "A wins";
        });
        const onA = await deviceA.all(app.conflict__rows.where({ id: seed.id }), {
          tier: "global",
        });
        assertEquals(onA[0].text, "A wins");

        // The one author-reachable malformed-submission shape never leaves
        // the client: committing an empty transaction throws synchronously,
        // so `invalid_batch_submission` cannot be provoked from this surface.
        assertThrows(() => deviceA.beginTransaction().commit());
      } finally {
        await Promise.allSettled([
          within(deviceA.logout(), "device A cleanup", 3000),
          within(deviceB.logout(), "device B cleanup", 3000),
        ]);
      }
    } finally {
      await node.stop();
    }
  },
});

Deno.test({
  name:
    "write verdict: a store without a permissions head rejects writes with permissions_head_missing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tables = { headless__rows: s.table({ text: s.string() }) };
    const app = s.defineApp(tables);
    const permissions = definePermissions(app, ({ policy, session }) => [
      policy.headless__rows.allowRead.where({ $createdBy: session.userId }),
      policy.headless__rows.allowInsert.where({ $createdBy: session.userId }),
    ]);

    const node = await createSyncNode({
      appId: crypto.randomUUID(),
      backendSecret: "lofi_backend_headless",
      adminSecret: "lofi_admin_headless",
      inMemory: true,
      mesh: "off",
    });
    const target = {
      appId: node.appId,
      serverUrl: node.url.replace(/^ws/, "http"),
      adminSecret: "lofi_admin_headless",
    };
    try {
      // Schema only — no permissions head. The store fails closed.
      await deploy({ ...target, schema: app });
      const device = await createDb({
        appId: node.appId,
        serverUrl: target.serverUrl,
        secret: accountSecret(35),
        userBranch: "main",
        driver: { type: "memory" },
      });
      try {
        const events: MutationErrorEvent[] = [];
        device.onMutationError((event) => events.push(event as MutationErrorEvent));

        const awaited = device.insert(app.headless__rows, { text: "awaited" });
        const unawaited = device.insert(app.headless__rows, { text: "un-awaited" });

        // Awaited surface: typed rejection, batch-correlated.
        const verdict = await within(settle(awaited), "awaited write settles");
        assertEquals(verdict.outcome, "rejected");
        const rejection = verdict as Rejection;
        assertEquals(rejection.name, "PersistedWriteRejectedError");
        assertEquals(rejection.code, "permissions_head_missing");
        assertEquals(rejection.batchId, awaited.batchId);
        assertEquals(classifyMutationError(rejection.code!), "permanent");

        // Fallback surface for the un-awaited write: same code, full batch
        // record with the persisted settlement.
        await pollUntil(
          "onMutationError fires for the un-awaited write",
          () => Promise.resolve(events.some((e) => e.batch.batchId === unawaited.batchId)),
        );
        const event = events.find((e) => e.batch.batchId === unawaited.batchId)!;
        assertEquals(event.code, "permissions_head_missing");
        assertEquals(event.batch.latestSettlement?.kind, "rejected");
        assertEquals(event.batch.latestSettlement?.code, "permissions_head_missing");

        // Publishing permissions afterwards does not revisit the persisted
        // fate; a new batch under the new head settles.
        await deploy({ ...target, schema: app, permissions });
        const after = await within(settle(awaited), "re-derived verdict after the head appears");
        assertEquals((after as Rejection).code, "permissions_head_missing");
        await pollUntil("a fresh write settles under the new head", async () => {
          const verdict = await within(
            settle(device.insert(app.headless__rows, { text: "fresh" })),
            "fresh write settles",
          );
          return verdict.outcome === "settled";
        });
      } finally {
        await within(device.logout(), "device cleanup", 3000).catch(() => {});
      }
    } finally {
      await node.stop();
    }
  },
});
