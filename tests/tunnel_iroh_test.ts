// Integration: a WebSocket carried end-to-end over a real iroh connection
// between two in-process nodes. Skips (with a visible marker) when the dylib
// is not resolvable. Sanitizers off: the acceptor's final parked db_accept
// cannot be cancelled (documented upstream gap).

import { assertEquals } from "jsr:@std/assert@1";
import { openIrohLib } from "../src/native/iroh.ts";
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
    const lib = openIrohLib();

    // Stand-in for the acceptor's local JazzServer: a WS echo server.
    const echo = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.addEventListener("message", (ev) => socket.send(ev.data));
      return response;
    });
    const echoUrl = `ws://127.0.0.1:${(echo.addr as Deno.NetAddr).port}`;

    const acceptorNode = await IrohNode.open(lib, crypto.getRandomValues(new Uint8Array(32)));
    const dialerNode = await IrohNode.open(lib, crypto.getRandomValues(new Uint8Array(32)));
    const acceptor = runTunnelAcceptor(acceptorNode, echoUrl);

    const peerAddr = await acceptorNode.addr();
    dialerNode.addAddr(peerAddr);
    const listener = startTunnelListener(dialerNode, peerAddr);

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

Deno.test({
  name: "loader reports a typed unavailable error rather than degrading silently",
  ignore: available,
  fn: () => {
    try {
      openIrohLib();
      throw new Error("expected MeshUnavailableError");
    } catch (e) {
      if (!(e instanceof MeshUnavailableError)) throw e;
    }
  },
});
