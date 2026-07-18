// WS-over-iroh bridge. One iroh connection carries exactly one WebSocket
// connection (v1: the Jazz upstream link — no multiplexing needed).
//
// Dialer side: a loopback WS listener; JazzServer's upstreamUrl points at it.
// Each accepted WS dials the peer over iroh, sends a HELLO frame naming the
// request path/subprotocol (the tunnel terminates WS on both ends, so upgrade
// parameters don't carry themselves), then bridges frames.
// Acceptor side: an accept loop; each inbound iroh conn reads HELLO, opens a
// WebSocket to the LOCAL JazzServer, and bridges the same way.

import type { IrohConn, IrohNode } from "./iroh/node.ts";

const DEBUG = Deno.env.get("LOFI_NODE_DEBUG") === "1";
function debug(...args: unknown[]): void {
  if (DEBUG) console.error("[tunnel]", ...args);
}

export const FRAME_HELLO = 0;
export const FRAME_TEXT = 1;
export const FRAME_BIN = 2;
export const FRAME_CLOSE = 3;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + payload.length);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

export function decodeFrame(bytes: Uint8Array): { type: number; payload: Uint8Array } {
  if (bytes.length === 0) return { type: -1, payload: new Uint8Array(0) };
  return { type: bytes[0], payload: bytes.subarray(1) };
}

export function encodeClose(code: number, reason: string): Uint8Array {
  const reasonBytes = encoder.encode(reason);
  const out = new Uint8Array(2 + reasonBytes.length);
  new DataView(out.buffer).setUint16(0, code, false);
  out.set(reasonBytes, 2);
  return out;
}

export function decodeClose(payload: Uint8Array): { code: number; reason: string } {
  if (payload.length < 2) return { code: 1000, reason: "" };
  const code = new DataView(payload.buffer, payload.byteOffset).getUint16(0, false);
  return { code, reason: decoder.decode(payload.subarray(2)) };
}

/** WS close codes 1005/1006/1015 (and out-of-range values) may not be passed
 * to close() — normalize what we relay. */
function sanitizeCloseCode(code: number): number {
  if (code < 1000 || code > 4999 || code === 1005 || code === 1006 || code === 1015) return 1000;
  return code;
}

interface Hello {
  path: string;
  protocol: string | null;
}

/** Pump both directions between an OPEN WebSocket and an iroh conn until
 * either side closes. `backlog` holds WS data that arrived before the conn was
 * ready (the WS side is push-based; the conn side is pull-based and needs no
 * buffering) — it is flushed before the message listener attaches, and both
 * happen synchronously, so no event can interleave. Resolves on teardown;
 * teardown is idempotent. */
export function bridge(
  conn: IrohConn,
  ws: WebSocket,
  backlog: (string | ArrayBuffer)[] = [],
): Promise<void> {
  ws.binaryType = "arraybuffer";
  let done: () => void;
  const finished = new Promise<void>((res) => (done = res));
  let torndown = false;

  const teardown = (notifyPeer: boolean, code = 1000, reason = "") => {
    if (torndown) return;
    torndown = true;
    if (notifyPeer) {
      try {
        conn.sendMsg(encodeFrame(FRAME_CLOSE, encodeClose(code, reason)));
      } catch {
        // conn already gone
      }
    }
    conn.close().catch(() => {});
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close(sanitizeCloseCode(code), reason.slice(0, 120));
      } catch {
        // already closing
      }
    }
    done();
  };

  const forward = (data: string | ArrayBuffer) => {
    try {
      if (typeof data === "string") {
        conn.sendMsg(encodeFrame(FRAME_TEXT, encoder.encode(data)));
      } else {
        conn.sendMsg(encodeFrame(FRAME_BIN, new Uint8Array(data)));
      }
    } catch {
      teardown(false, 1011, "tunnel send failed");
    }
  };
  for (const data of backlog) forward(data);
  backlog.length = 0;
  ws.addEventListener("message", (ev) => forward(ev.data));
  ws.addEventListener("close", (ev) => teardown(true, ev.code || 1000, ev.reason ?? ""));
  ws.addEventListener("error", () => teardown(true, 1011, "ws error"));

  (async () => {
    while (!torndown) {
      const msg = await conn.recvMsg();
      if (msg === null) {
        teardown(false, 1006, "tunnel closed");
        break;
      }
      const { type, payload } = decodeFrame(msg);
      if (type === FRAME_TEXT) ws.send(decoder.decode(payload));
      else if (type === FRAME_BIN) ws.send(payload);
      else if (type === FRAME_CLOSE) {
        const { code, reason } = decodeClose(payload);
        teardown(false, code, reason);
        break;
      }
      // Unknown frame types are ignored (forward compat).
    }
  })();

  return finished;
}

export interface TunnelListener {
  /** Loopback port; use ws://127.0.0.1:<port> as JazzServer upstreamUrl. */
  port: number;
  close(): Promise<void>;
}

/** Dialer side: serve a loopback WS endpoint that carries each connection to
 * `peerAddr` over iroh. */
export function startTunnelListener(
  node: IrohNode,
  peerAddr: Uint8Array,
  options: { port?: number } = {},
): TunnelListener {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: options.port ?? 0, onListen: () => {} },
    (req) => {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response("lofi-node tunnel (WebSocket only)", { status: 426 });
      }
      const requestedProtocol = req.headers.get("sec-websocket-protocol");
      const { socket, response } = Deno.upgradeWebSocket(
        req,
        requestedProtocol ? { protocol: requestedProtocol.split(",")[0].trim() } : {},
      );
      const url = new URL(req.url);
      // Buffer WS data that lands while the iroh dial is in flight; bridge()
      // flushes it before attaching its own listener (same task, no gap).
      const backlog: (string | ArrayBuffer)[] = [];
      const buffer = (ev: MessageEvent) => backlog.push(ev.data);
      socket.addEventListener("message", buffer);
      socket.addEventListener("open", async () => {
        try {
          const conn = await node.connect(peerAddr);
          const hello: Hello = { path: url.pathname + url.search, protocol: requestedProtocol };
          debug("dialer: connected, HELLO", hello);
          conn.sendMsg(encodeFrame(FRAME_HELLO, encoder.encode(JSON.stringify(hello))));
          socket.removeEventListener("message", buffer);
          bridge(conn, socket, backlog);
        } catch {
          try {
            socket.close(1011, "tunnel dial failed");
          } catch {
            // already closed
          }
        }
      });
      return response;
    },
  );
  return {
    port: (server.addr as Deno.NetAddr).port,
    close: () => server.shutdown(),
  };
}

export interface TunnelAcceptor {
  /** Stops handing new conns to the bridge. The final parked db_accept cannot
   * be cancelled (upstream gap) — daemon teardown is process exit. */
  close(): void;
}

/** Acceptor side: bridge every inbound iroh conn to the local Jazz server. */
export function runTunnelAcceptor(node: IrohNode, localWsUrl: string): TunnelAcceptor {
  let stopped = false;

  async function handleInbound(conn: IrohConn): Promise<void> {
    const first = await conn.recvMsg();
    if (first === null) return;
    const { type, payload } = decodeFrame(first);
    if (type !== FRAME_HELLO) {
      await conn.close();
      return;
    }
    let hello: Hello;
    try {
      hello = JSON.parse(decoder.decode(payload)) as Hello;
    } catch {
      await conn.close();
      return;
    }
    const target = new URL(hello.path || "/", localWsUrl);
    debug("acceptor: HELLO", hello, "→ dialing local", target.href);
    const ws = hello.protocol
      ? new WebSocket(target, hello.protocol.split(",").map((s) => s.trim()))
      : new WebSocket(target);
    ws.addEventListener("open", () => {
      debug("acceptor: local ws open, bridging");
      bridge(conn, ws);
    });
    ws.addEventListener("error", (ev) => {
      debug("acceptor: local ws error", (ev as ErrorEvent).message ?? "");
      conn.close().catch(() => {});
    });
  }

  (async () => {
    while (!stopped) {
      let conn: IrohConn;
      try {
        conn = await node.accept();
      } catch {
        if (stopped) break;
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      if (stopped) {
        conn.close().catch(() => {});
        break;
      }
      handleInbound(conn).catch(() => {});
    }
  })();

  return {
    close: () => {
      stopped = true;
    },
  };
}
