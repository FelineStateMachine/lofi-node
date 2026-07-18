// Integration: a WebSocket carried end-to-end over a real iroh connection
// between two in-process endpoints (vendored iroh-js addon). Skips with a
// visible marker when the addon is not built. Sanitizers off: the addon's
// tokio runtime and QUIC endpoints outlive the test body.

import { assertEquals } from "@std/assert";
import { loadIrohAddon } from "../src/native/addon.ts";
import { IrohNode } from "../src/iroh/node.ts";
import { resolveIrohLib } from "../src/native/loader.ts";
import { runTunnelAcceptor, startTunnelListener } from "../src/tunnel.ts";
import { MeshUnavailableError } from "../src/errors.ts";

const available = resolveIrohLib().status === "ok";

Deno.test({
  name: "ws echo through the iroh tunnel (dialer ws → iroh → acceptor ws)",
  ignore: !available,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const addon = await loadIrohAddon();

    // Stand-in for the acceptor's local JazzServer: a WS echo server.
    const echo = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.addEventListener("message", (ev) => socket.send(ev.data));
      return response;
    });
    const echoUrl = `ws://127.0.0.1:${(echo.addr as Deno.NetAddr).port}`;

    const acceptorNode = await IrohNode.open(addon, crypto.getRandomValues(new Uint8Array(32)));
    const dialerNode = await IrohNode.open(addon, crypto.getRandomValues(new Uint8Array(32)));
    const acceptor = runTunnelAcceptor(acceptorNode, echoUrl);

    const ticket = await acceptorNode.ticket();
    const listener = startTunnelListener(dialerNode, ticket);

    const client = new WebSocket(`ws://127.0.0.1:${listener.port}/sync?key=test`);
    client.binaryType = "arraybuffer";
    const received: (string | Uint8Array)[] = [];
    const gotBoth = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("echo timeout (15s)")), 15_000);
      client.addEventListener("message", (ev) => {
        received.push(
          typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer),
        );
        if (received.length === 2) {
          clearTimeout(timer);
          resolve();
        }
      });
      client.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("client ws error"));
      });
    });
    await new Promise<void>((resolve, reject) => {
      client.addEventListener("open", () => resolve());
      client.addEventListener("close", () => reject(new Error("closed before open")));
    });
    client.send("ping over iroh");
    client.send(new Uint8Array([1, 2, 3, 4]).buffer);
    await gotBoth;

    assertEquals(received[0], "ping over iroh");
    assertEquals(received[1], new Uint8Array([1, 2, 3, 4]));

    client.close(1000, "done");
    await new Promise((r) => setTimeout(r, 300));
    acceptor.close();
    await listener.close();
    await echo.shutdown();
    await dialerNode.close();
    await acceptorNode.close();
  },
});

Deno.test("release artifacts manifest matches deno.json version and prebuilt digests", async () => {
  const { RELEASE_ARTIFACTS } = await import("../src/native/artifacts.ts");
  const denoJson = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url)));
  assertEquals(
    RELEASE_ARTIFACTS.version,
    denoJson.version,
    "run `deno task release:artifacts` after a version bump",
  );
  for (const [platform, asset] of Object.entries(RELEASE_ARTIFACTS.assets)) {
    assertEquals(asset.sha256.length, 64, `${platform} digest is sha256 hex`);
    assertEquals(
      /^libnumber0_iroh-[a-z0-9_]+-[a-z-]+\.(dylib|so)$/.test(asset.file),
      true,
      `${platform} asset name shape: ${asset.file}`,
    );
  }
});
