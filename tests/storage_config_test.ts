// Storage election: user-chosen sqlite path honored on disk, unwritable paths
// fail fast and named, v1 configs migrate to v2 defaults.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createSyncNode } from "../src/node.ts";
import { initConfig, loadConfig, saveConfig } from "../src/config.ts";

Deno.test({
  name: "storage: user-chosen sqlite path is honored on disk",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dir = await Deno.makeTempDir();
    const node = await createSyncNode({
      appId: crypto.randomUUID(),
      backendSecret: "b",
      adminSecret: "a",
      mesh: "off",
      storage: { type: "sqlite", path: `${dir}/my-chosen-location` },
    });
    try {
      assertEquals(node.status().jazz.storage, {
        type: "sqlite",
        path: `${dir}/my-chosen-location`,
      });
      const files = [...Deno.readDirSync(`${dir}/my-chosen-location`)].map((e) => e.name);
      assert(files.length > 0, `jazz wrote into the chosen path (found: ${files.join(", ")})`);
    } finally {
      await node.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "storage: unwritable path fails fast with the path named",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await assertRejects(
      () =>
        createSyncNode({
          appId: crypto.randomUUID(),
          backendSecret: "b",
          adminSecret: "a",
          mesh: "off",
          storage: { type: "sqlite", path: "/dev/null/not-a-dir" },
        }),
      Error,
      "/dev/null/not-a-dir",
    );
  },
});

Deno.test("config: v1 file migrates to v2 with open access + sqlite storage", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/config.json`,
      JSON.stringify({
        v: 1,
        appId: "11111111-1111-1111-1111-111111111111",
        backendSecret: "b",
        adminSecret: "a",
        listenPort: 4900,
        upstream: "none",
        allowLocalFirstAuth: true,
      }),
    );
    const config = await loadConfig(dir);
    assert(config !== null);
    assertEquals(config.v, 2);
    assertEquals(config.access, "open", "v1 dirs keep today's behavior");
    assertEquals(config.storage, { type: "sqlite" });
    await saveConfig(dir, config);
    assertEquals(JSON.parse(await Deno.readTextFile(`${dir}/config.json`)).v, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("config: new inits default to ticket access", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const config = await initConfig(dir);
    assertEquals(config.access, "ticket");
    assertEquals(config.storage, { type: "sqlite" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
