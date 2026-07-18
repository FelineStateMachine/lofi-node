// E2E for issue #2 §3: the lofi#109 slice-merge provisioning flow carried
// entirely through the gate on provision-scoped tickets — the client NEVER
// holds the admin secret (it sends a dummy; the gate strips and injects).
//
// Mirrors the validated direct-server experiment: deploy slice A → union
// (A+B) with a createTables migration → old-hash client keeps syncing, the
// union client uses both slices. Store-status classifies before/after.
//
// Schemas are defined INSIDE test fns: jazz registers schemas process-
// globally at definition time, and module-level definitions here would
// clobber the declared hash of other test files' clients.

import { assert, assertEquals } from "@std/assert";
import { createDb, schema as s } from "jazz-tools";
import { deploy } from "jazz-tools/testing";
import { definePermissions } from "jazz-tools/permissions";
import { createSyncNode } from "../src/node.ts";
import { decodeAppTicket } from "../src/appticket.ts";
import { resolveIrohLib } from "../src/native/loader.ts";

const DUMMY_ADMIN = "client-never-holds-the-real-secret";

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

async function fetchStoreStatus(ticketUrl: string) {
  const res = await fetch(`${ticketUrl}/store-status`);
  assertEquals(res.status, 200, "store-status reachable");
  return await res.json() as {
    v: 1;
    appId: string;
    schema: { deployed: boolean; headHash?: string; permissionsHead?: string | null };
  };
}

Deno.test({
  name: "provisioning: slice A → union merge with createTables, all through the gate",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const node = await createSyncNode({
      appId: crypto.randomUUID(),
      backendSecret: "lofi_backend_prov",
      adminSecret: "real-node-admin-secret",
      inMemory: true,
      mesh: "off",
      access: "ticket",
    });
    try {
      const provision = decodeAppTicket(
        (await node.issueTicket({ label: "provisioner", scope: "provision" })).ticket,
      )!;
      const sync = decodeAppTicket((await node.issueTicket({ label: "device" })).ticket)!;
      assertEquals(provision.scope, "provision");
      assertEquals(sync.scope, undefined, "sync scope omitted from the string (default)");

      // Preflight against the EMPTY store: this is the state where writes
      // would hang; the classifier must see no_schema. Sync scope suffices.
      const before = await fetchStoreStatus(sync.url);
      assertEquals(before.schema, { deployed: false });

      // ---- Slice A deploys through the PROVISION ticket, dummy admin. ----
      const sliceATables = {
        aapp__items: s.table({ text: s.string() }),
      };
      const appA = s.defineApp(sliceATables);
      const permsA = definePermissions(appA, ({ policy, session }) => [
        policy.aapp__items.allowRead.where({ $createdBy: session.userId }),
        policy.aapp__items.allowInsert.where({ $createdBy: session.userId }),
      ]);
      const resultA = await deploy({
        appId: node.appId,
        serverUrl: provision.url,
        adminSecret: DUMMY_ADMIN,
        schema: appA,
        permissions: permsA,
      });
      const hashA = (resultA as { schema: { hash: string } }).schema.hash;

      const afterA = await fetchStoreStatus(sync.url);
      assertEquals(afterA.schema.deployed, true);
      assertEquals(afterA.schema.headHash, hashA, "head hash tracks slice A");
      assert(afterA.schema.permissionsHead, "permissions head present");

      // Old-hash client boots NOW (declared schema = slice A) over the SYNC
      // ticket and writes.
      const clientA = await createDb({
        appId: node.appId,
        serverUrl: sync.url,
        secret: accountSecret(3),
        userBranch: "main",
        driver: { type: "memory" },
      });
      try {
        await within(
          clientA.insert(appA.aapp__items, { text: "pre-merge write" }).wait({ tier: "global" }),
          "slice-A client write before merge",
        );

        // ---- App B joins the occupied store: union + createTables. ----
        const unionTables = {
          ...sliceATables,
          bapp__notes: s.table({ body: s.string() }),
        };
        const appUnion = s.defineApp(unionTables);
        const permsUnion = definePermissions(appUnion, ({ policy, session }) => [
          policy.aapp__items.allowRead.where({ $createdBy: session.userId }),
          policy.aapp__items.allowInsert.where({ $createdBy: session.userId }),
          policy.bapp__notes.allowRead.where({ $createdBy: session.userId }),
          policy.bapp__notes.allowInsert.where({ $createdBy: session.userId }),
        ]);
        const migration = s.defineMigration({
          from: sliceATables,
          to: unionTables,
          createTables: { bapp__notes: true },
        });
        const resultUnion = await deploy({
          appId: node.appId,
          serverUrl: provision.url,
          adminSecret: DUMMY_ADMIN,
          schema: appUnion,
          permissions: permsUnion,
          migration,
        });
        const hashUnion = (resultUnion as { schema: { hash: string } }).schema.hash;
        assert(hashUnion !== hashA, "union hash advanced");

        const afterUnion = await fetchStoreStatus(sync.url);
        assertEquals(afterUnion.schema.headHash, hashUnion, "head hash tracks the union");

        // Old-hash client CONTINUITY: clientA (declared hash A) keeps
        // syncing untouched after the merge — the lofi#109 invariant.
        await within(
          clientA.insert(appA.aapp__items, { text: "post-merge write" }).wait({ tier: "global" }),
          "slice-A client write AFTER merge (old-hash continuity)",
        );

        // Union client uses BOTH slices through the sync ticket.
        const clientUnion = await createDb({
          appId: node.appId,
          serverUrl: sync.url,
          secret: accountSecret(4),
          userBranch: "main",
          driver: { type: "memory" },
        });
        try {
          await within(
            clientUnion.insert(appUnion.bapp__notes, { body: "new slice works" })
              .wait({ tier: "global" }),
            "union client writes the new slice",
          );
          await within(
            clientUnion.insert(appUnion.aapp__items, { text: "old slice too" })
              .wait({ tier: "global" }),
            "union client writes the original slice",
          );
        } finally {
          await within(clientUnion.logout(), "union client cleanup", 3000).catch(() => {});
        }
      } finally {
        await within(clientA.logout(), "slice-A client cleanup", 3000).catch(() => {});
      }

      // ---- Negative: the SYNC ticket cannot deploy (401 at the gate). ----
      let syncDeployFailed = false;
      try {
        await deploy({
          appId: node.appId,
          serverUrl: sync.url,
          adminSecret: "even-the-real-one-would-not-help",
          schema: appA,
          permissions: permsA,
        });
      } catch {
        syncDeployFailed = true;
      }
      assert(syncDeployFailed, "sync-scoped ticket must not provision");
    } finally {
      await node.stop();
    }
  },
});

Deno.test({
  name: "provisioning: through an iroh-paired leaf lands on the root",
  ignore: resolveIrohLib().status !== "ok",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const shared = {
      appId: crypto.randomUUID(),
      backendSecret: "lofi_backend_leafprov",
      adminSecret: "leafprov-admin-secret",
    };
    const root = await createSyncNode({ ...shared, inMemory: true, access: "ticket" });
    const leaf = await createSyncNode({
      ...shared,
      inMemory: true,
      access: "ticket",
      upstream: { peer: root.ticket() },
    });
    try {
      const leafProvision = decodeAppTicket(
        (await leaf.issueTicket({ label: "leaf-prov", scope: "provision" })).ticket,
      )!;
      const rootSync = decodeAppTicket((await root.issueTicket({ label: "root-dev" })).ticket)!;

      const tables = { leafapp__rows: s.table({ text: s.string() }) };
      const app = s.defineApp(tables);
      const perms = definePermissions(app, ({ policy, session }) => [
        policy.leafapp__rows.allowRead.where({ $createdBy: session.userId }),
        policy.leafapp__rows.allowInsert.where({ $createdBy: session.userId }),
      ]);
      // Deploy THROUGH the leaf's gate; the leaf's Jazz proxies catalogue
      // writes to its upstream over the iroh tunnel → lands on the root.
      const result = await deploy({
        appId: shared.appId,
        serverUrl: leafProvision.url,
        adminSecret: DUMMY_ADMIN,
        schema: app,
        permissions: perms,
      });
      const hash = (result as { schema: { hash: string } }).schema.hash;

      // The ROOT's store-status sees the schema deployed via the leaf.
      const rootStatus = await fetchStoreStatus(rootSync.url);
      assertEquals(rootStatus.schema.deployed, true, "root store has the schema");
      assertEquals(rootStatus.schema.headHash, hash, "root head hash matches leaf deploy");
    } finally {
      await leaf.stop();
      await root.stop();
    }
  },
});
