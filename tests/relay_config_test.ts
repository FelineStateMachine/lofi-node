// Relay election: persisted in config.json, validated at load and node
// start, and applied to the iroh endpoint (disabled relays still connect
// directly on the local network; custom relay maps bind cleanly).

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { initConfig, loadConfig, validateRelay } from "../src/config.ts";
import { createSyncNode } from "../src/node.ts";
import { loadIrohAddon } from "../src/native/addon.ts";
import { IrohNode } from "../src/iroh/node.ts";
import { resolveIrohLib } from "../src/native/loader.ts";

const available = resolveIrohLib().status === "ok";

Deno.test("relay: absent from new configs (n0 default) and round-trips when set", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const config = await initConfig(dir, {
      relay: { urls: ["https://relay.example.com", "https://relay2.example.com"] },
    });
    assertEquals(config.relay, {
      urls: ["https://relay.example.com", "https://relay2.example.com"],
    });
    const loaded = await loadConfig(dir);
    assertEquals(loaded?.relay, {
      urls: ["https://relay.example.com", "https://relay2.example.com"],
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  const plain = await Deno.makeTempDir();
  try {
    const config = await initConfig(plain, {});
    assertEquals(config.relay, undefined);
  } finally {
    await Deno.remove(plain, { recursive: true });
  }
});

Deno.test("relay: malformed elections are rejected with the offending value", () => {
  validateRelay("n0");
  validateRelay("disabled");
  validateRelay({ urls: ["http://localhost:3340"] });
  assertThrows(() => validateRelay({ urls: [] }), Error, "at least one relay URL");
  assertThrows(() => validateRelay({ urls: ["not a url"] }), Error, '"not a url"');
  assertThrows(() => validateRelay({ urls: ["ftp://relay.example.com"] }), Error, "http(s)");
});

Deno.test("relay: a config.json with a bad relay fails at load, not at dial time", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const config = await initConfig(dir, {});
    await Deno.writeTextFile(
      `${dir}/config.json`,
      JSON.stringify({ ...config, relay: { urls: [] } }),
    );
    await assertRejects(() => loadConfig(dir), Error, "at least one relay URL");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "relay: createSyncNode rejects a bad election before any boot work",
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
          relay: { urls: [] },
        }),
      Error,
      "at least one relay URL",
    );
  },
});

Deno.test({
  name: "relay: disabled endpoints still pair over direct addresses",
  ignore: !available,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const addon = await loadIrohAddon();
    const a = await IrohNode.open(addon, crypto.getRandomValues(new Uint8Array(32)), "disabled");
    const b = await IrohNode.open(addon, crypto.getRandomValues(new Uint8Array(32)), "disabled");
    try {
      const ticket = await a.ticket();
      const acceptPromise = a.accept();
      const dialed = await b.connect(ticket);
      const accepted = await acceptPromise;
      assert(accepted !== null, "acceptor saw the inbound connection");
      dialed.sendMsg(new TextEncoder().encode("direct only"));
      const got = await accepted.recvMsg();
      assertEquals(new TextDecoder().decode(got!), "direct only");
      await dialed.close();
      await accepted.close();
    } finally {
      await a.close();
      await b.close();
    }
  },
});

Deno.test({
  name: "relay: a custom relay map binds cleanly (no dial attempt at boot)",
  ignore: !available,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const addon = await loadIrohAddon();
    const node = await IrohNode.open(addon, crypto.getRandomValues(new Uint8Array(32)), {
      urls: ["https://relay.invalid.example"],
    });
    try {
      assert(node.idString().length > 0);
    } finally {
      await node.close();
    }
  },
});
