// Secret files are owner-only on disk: config.json (backendSecret,
// adminSecret) 0600, iroh.key 0600, the data dir 0700 — and installs created
// before modes were set are healed on load. POSIX-only; Windows has no chmod.

import { assertEquals } from "@std/assert";
import { configPath, initConfig, loadConfig, loadOrCreateIrohKey } from "../src/config.ts";

const posixOnly = { ignore: Deno.build.os === "windows" };

async function modeOf(path: string): Promise<number> {
  const stat = await Deno.stat(path);
  return (stat.mode ?? 0) & 0o777;
}

Deno.test({
  ...posixOnly,
  name: "permissions: initConfig writes config.json 0600 in a 0700 data dir",
  fn: async () => {
    const parent = await Deno.makeTempDir();
    const dir = `${parent}/data`;
    try {
      await initConfig(dir);
      assertEquals(await modeOf(dir), 0o700);
      assertEquals(await modeOf(configPath(dir)), 0o600);
    } finally {
      await Deno.remove(parent, { recursive: true });
    }
  },
});

Deno.test({
  ...posixOnly,
  name: "permissions: loadConfig heals a loose existing install",
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      await initConfig(dir);
      // An install from before modes were set: world-readable everywhere.
      await Deno.chmod(dir, 0o755);
      await Deno.chmod(configPath(dir), 0o644);
      await loadConfig(dir);
      assertEquals(await modeOf(dir), 0o700);
      assertEquals(await modeOf(configPath(dir)), 0o600);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  ...posixOnly,
  name: "permissions: iroh.key is 0600 on create and healed on load",
  fn: async () => {
    const dir = await Deno.makeTempDir();
    try {
      await loadOrCreateIrohKey(dir);
      assertEquals(await modeOf(`${dir}/iroh.key`), 0o600);
      await Deno.chmod(`${dir}/iroh.key`, 0o644);
      await loadOrCreateIrohKey(dir);
      assertEquals(await modeOf(`${dir}/iroh.key`), 0o600);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
