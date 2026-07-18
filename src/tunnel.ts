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

/** kind "ws" (or absent, legacy): one WebSocket per conn. kind "http": one
 * request/response per conn — HELLO{method,path,headers} + BIN body up,
 * HELLO{status,headers} + BIN body back. Jazz leaves proxy their catalogue
 * (schema/permissions) HTTP reads to their upstream, so the tunnel must carry
 * plain HTTP as well as the sync WebSocket. */
interface Hello {
  kind?: "ws" | "http";
  path: string;
  protocol?: string | null;
  method?: string;
  headers?: Record<string, string>;
}

interface HttpResponseHead {
  status: number;
  headers: Record<string, string>;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function forwardableHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
  }
  return out;
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
 * the peer named by `peerTicket` over iroh. */
export function startTunnelListener(
  node: IrohNode,
  peerTicket: string,
  options: { port?: number } = {},
): TunnelListener {
  async function proxyHttp(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let conn: IrohConn;
    try {
      conn = await node.connect(peerTicket);
    } catch {
      return new Response("tunnel dial failed", { status: 502 });
    }
    try {
      const hello: Hello = {
        kind: "http",
        method: req.method,
        path: url.pathname + url.search,
        headers: forwardableHeaders(req.headers),
      };
      conn.sendMsg(encodeFrame(FRAME_HELLO, encoder.encode(JSON.stringify(hello))));
      conn.sendMsg(encodeFrame(FRAME_BIN, new Uint8Array(await req.arrayBuffer())));
      const headFrame = await conn.recvMsg();
      const bodyFrame = headFrame === null ? null : await conn.recvMsg();
      if (headFrame === null || bodyFrame === null) {
        return new Response("tunnel closed mid-response", { status: 502 });
      }
      const head = JSON.parse(decoder.decode(decodeFrame(headFrame).payload)) as HttpResponseHead;
      debug("dialer: http", hello.method, hello.path, "→", head.status);
      return new Response(toArrayBuffer(decodeFrame(bodyFrame).payload), {
        status: head.status,
        headers: head.headers,
      });
    } catch (e) {
      debug("dialer: http proxy error", (e as Error).message);
      return new Response("tunnel proxy error", { status: 502 });
    } finally {
      conn.close().catch(() => {});
    }
  }

  const server = Deno.serve(
    { hostname: "127.0.0.1", port: options.port ?? 0, onListen: () => {} },
    (req) => {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return proxyHttp(req);
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
          const conn = await node.connect(peerTicket);
          const hello: Hello = {
            kind: "ws",
            path: url.pathname + url.search,
            protocol: requestedProtocol,
          };
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
  /** Stops handing new conns to the bridge; the loop also exits cleanly when
   * the endpoint closes (accept resolves null). */
  close(): void;
}

/** Acceptor side: bridge every inbound iroh conn to the local Jazz server. */
export function runTunnelAcceptor(node: IrohNode, localWsUrl: string): TunnelAcceptor {
  let stopped = false;
  const localHttpUrl = localWsUrl.replace(/^ws/, "http");

  async function handleHttp(conn: IrohConn, hello: Hello): Promise<void> {
    const bodyFrame = await conn.recvMsg();
    if (bodyFrame === null) {
      await conn.close();
      return;
    }
    const body = decodeFrame(bodyFrame).payload;
    const method = hello.method ?? "GET";
    let head: HttpResponseHead;
    let responseBody: Uint8Array;
    try {
      const res = await fetch(new URL(hello.path || "/", localHttpUrl), {
        method,
        headers: hello.headers,
        body: method === "GET" || method === "HEAD" ? undefined : toArrayBuffer(body),
      });
      head = { status: res.status, headers: forwardableHeaders(res.headers) };
      responseBody = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      debug("acceptor: local http error", (e as Error).message);
      head = { status: 502, headers: {} };
      responseBody = encoder.encode("local fetch failed");
    }
    debug("acceptor: http", method, hello.path, "→", head.status);
    try {
      conn.sendMsg(encodeFrame(FRAME_HELLO, encoder.encode(JSON.stringify(head))));
      conn.sendMsg(encodeFrame(FRAME_BIN, responseBody));
    } catch {
      // peer gone
    }
    await conn.close();
  }

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
    if (hello.kind === "http") {
      await handleHttp(conn, hello);
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
      let conn: IrohConn | null;
      try {
        conn = await node.accept();
      } catch {
        if (stopped) break;
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      if (conn === null) break; // endpoint closed — clean exit
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
