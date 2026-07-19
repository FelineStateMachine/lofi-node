// Write-verdict harness: the three server-side properties a client-side write
// journal needs to record verdicts without a server ledger.
//
// The server only adjudicates writes made under a STALE policy: the client
// runtime enforces the locally-known policy synchronously at the call site,
// so a server rejection requires the store's permissions to tighten after the
// client last synced them. The fixture models exactly that — permission
// revoked at the store while the writing device is offline.
//
// Properties exercised:
// 1. Correlation — a rejected write surfaces `permission_denied` with the
//    originating write's batch id, on both verdict surfaces (`wait()` →
//    `PersistedWriteRejectedError`, and the `onMutationError` fallback event
//    for writes nobody awaited).
// 2. Re-derivability — a write unacked at disconnect is re-sent on reconnect
//    and the rejection fires then; nothing is lost to the disconnect.
// 3. Determinism — the verdict for a batch is stable across further
//    reconnects, and an independent runtime issuing the same write against
//    the same store state derives the same code. The fallback event itself
//    is delivered once per runtime lifetime (not re-fired on later
//    reconnects), so a journal must persist the verdict when it arrives;
//    re-derivation on demand goes through `wait()`.
//
// Schemas are defined INSIDE the test fn: jazz registers schemas process-
// globally at definition time, and module-level definitions would clobber
// other test files' declared hashes.

import { assert, assertEquals } from "@std/assert";
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
  predicate: () => boolean,
  milliseconds = 15_000,
): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} did not become true within ${milliseconds}ms`);
}

Deno.test({
  name: "write verdict: rejection correlates by batch id, survives reconnect, and is deterministic",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const tables = { verdict__entries: s.table({ text: s.string() }) };
    const app = s.defineApp(tables);
    const permissive = definePermissions(app, ({ policy, session }) => [
      policy.verdict__entries.allowRead.where({ $createdBy: session.userId }),
      policy.verdict__entries.allowInsert.where({ $createdBy: session.userId }),
    ]);
    const readOnly = definePermissions(app, ({ policy, session }) => [
      policy.verdict__entries.allowRead.where({ $createdBy: session.userId }),
    ]);

    const node = await createSyncNode({
      appId: crypto.randomUUID(),
      backendSecret: "lofi_backend_verdict",
      adminSecret: "lofi_admin_verdict",
      inMemory: true,
      mesh: "off",
    });
    const target = {
      appId: node.appId,
      serverUrl: node.url.replace(/^ws/, "http"),
      adminSecret: "lofi_admin_verdict",
    };
    try {
      await deploy({ ...target, schema: app, permissions: permissive });

      // Two devices of one account, both booted while inserts are allowed, so
      // both hold the permissive policy locally.
      const secret = accountSecret(21);
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
        await within(
          deviceA.insert(app.verdict__entries, { text: "seed" }).wait({ tier: "global" }),
          "seed write under the permissive policy",
        );

        // Both devices go offline; the store's policy tightens underneath.
        await deviceA.disconnect();
        await deviceB.disconnect();
        await deploy({ ...target, schema: app, permissions: readOnly });

        // Offline writes under the stale (permissive) policy: the local
        // runtime accepts them and hands back batch ids.
        const awaited = deviceA.insert(app.verdict__entries, { text: "awaited stale write" });
        const unawaited = deviceA.insert(app.verdict__entries, { text: "un-awaited stale write" });
        const fromB = deviceB.insert(app.verdict__entries, { text: "device B stale write" });
        assert(awaited.batchId !== unawaited.batchId, "distinct writes, distinct batch ids");

        const events: MutationErrorEvent[] = [];
        deviceA.onMutationError((event) => events.push(event as MutationErrorEvent));

        // Property 2 — the unacked writes are re-sent on reconnect and the
        // rejection fires then.
        await deviceA.reconnect();

        // Property 1a — the awaited surface: a typed rejection carrying the
        // originating batch id and a machine-readable code.
        const verdict = await within(settle(awaited), "awaited stale write settles");
        assertEquals(verdict.outcome, "rejected");
        const rejection = verdict as Rejection;
        assertEquals(rejection.name, "PersistedWriteRejectedError");
        assertEquals(rejection.batchId, awaited.batchId, "verdict correlates to the write");
        assertEquals(rejection.code, "permission_denied");
        assertEquals(classifyMutationError(rejection.code!), "permanent");
        assert(rejection.reason && rejection.reason.length > 0, "reason present (diagnostics)");

        // Property 1b — the fallback event surface for writes nobody awaited:
        // the event carries the batch record, correlating by batch id.
        await pollUntil(
          "onMutationError fires for the un-awaited write",
          () => events.some((e) => e.batch.batchId === unawaited.batchId),
        );
        const event = events.find((e) => e.batch.batchId === unawaited.batchId)!;
        assertEquals(event.code, "permission_denied");
        assertEquals(event.batch.sealed, true);
        assertEquals(event.batch.latestSettlement?.kind, "rejected");
        assertEquals(event.batch.latestSettlement?.code, "permission_denied");
        const eventsAfterFirstCycle = events.length;

        // Property 3a — the verdict is stable across further reconnects, and
        // re-waiting re-derives it without a new fallback event.
        await deviceA.disconnect();
        await deviceA.reconnect();
        const again = await within(settle(awaited), "re-derived verdict after reconnect");
        assertEquals(again.outcome, "rejected");
        assertEquals((again as Rejection).code, "permission_denied");
        assertEquals((again as Rejection).batchId, awaited.batchId);
        const unawaitedAgain = await within(settle(unawaited), "un-awaited verdict via wait()");
        assertEquals((unawaitedAgain as Rejection).code, "permission_denied");
        // Delivered once per runtime lifetime: the reconnect did not re-fire
        // events for already-settled batches. A journal must persist the
        // verdict when it first arrives.
        await new Promise((r) => setTimeout(r, 1500));
        assertEquals(events.length, eventsAfterFirstCycle, "no event re-fire on reconnect");

        // Property 3b — an independent runtime, same account, same store
        // state, same write shape: the same code.
        await deviceB.reconnect();
        const verdictB = await within(settle(fromB), "device B stale write settles");
        assertEquals(verdictB.outcome, "rejected");
        assertEquals((verdictB as Rejection).code, "permission_denied");
        assertEquals((verdictB as Rejection).batchId, fromB.batchId);

        // Once the tightened policy has synced to a device, writes it denies
        // never reach the server again: the local runtime refuses them
        // synchronously at the call site, before any batch exists. These
        // surface as thrown errors to the author, not as write verdicts.
        // (Until that sync lands — fresh boot, first reconnect — the same
        // write is accepted locally and adjudicated by the server, as above.)
        let localRefusal: Error | null = null;
        await pollUntil("local enforcement of the synced read-only policy", () => {
          try {
            deviceA.insert(app.verdict__entries, { text: "refused?" });
            return false;
          } catch (e) {
            localRefusal = e as Error;
            return true;
          }
        });
        assert(
          (localRefusal as unknown as Error).message.includes("policy denied INSERT"),
          `local refusal names the policy: ${(localRefusal as unknown as Error).message}`,
        );
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
