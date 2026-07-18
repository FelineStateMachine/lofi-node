// The access gate: lofi-node's public front listener. JazzServer binds
// loopback-only, so the gate is BOTH the enforcement point for app tickets
// and what makes the node reachable beyond localhost at all.
//
// Ticket mode routes requests shaped /t/<secret>/… — the secret arrives as a
// serverUrl base-path prefix (jazz clients preserve base paths through every
// WS connect and catalogue fetch), gets verified against the ticket store
// (timing-safe, digest vs digest), and is stripped before proxying to the
// internal Jazz port. WS is terminated and re-originated (safe: Jazz auth is
// an in-band frame, proven by the iroh tunnel doing the same); HTTP streams.

import { AppTicketStore, SECRET_LENGTH } from "./appticket.ts";
import { forwardableHeaders, sanitizeCloseCode } from "./tunnel.ts";

const DEBUG = Deno.env.get("LOFI_NODE_DEBUG") === "1";
function debug(...args: unknown[]): void {
  if (DEBUG) console.error("[gate]", ...args);
}

/** WS close code sent when a ticket is revoked mid-session; the app should
 * surface re-enrollment (see docs/app-ticket.md). */
export const CLOSE_TICKET_REVOKED = 4001;

const TICKET_PATH = new RegExp(`^/t/([A-Za-z0-9_-]{${SECRET_LENGTH}})(/.*)?$`);

export interface GateOptions {
  port: number;
  hostname?: string;
  /** Internal Jazz http URL, read per-request so Jazz restarts (pair()) never
   * invalidate the gate. */
  target: () => string;
  mode: "open" | "ticket";
  store: AppTicketStore;
}

export interface Gate {
  port: number;
  url: string;
  /** Live gated WS connections per ticket id. */
  stats(): { ticketId: string; connections: number }[];
  close(): Promise<void>;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "invalid_ticket" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/** Pump two OPEN (or opening) WebSockets both ways until either closes.
 * `backlog` holds client data that arrived before the upstream dial finished;
 * flushed before the listener attaches (same task — no interleave). */
export function pumpWebSockets(
  client: WebSocket,
  upstream: WebSocket,
  backlog: (string | ArrayBuffer)[] = [],
): void {
  client.binaryType = "arraybuffer";
  upstream.binaryType = "arraybuffer";
  let torndown = false;
  const teardown = (code: number, reason: string) => {
    if (torndown) return;
    torndown = true;
    for (const ws of [client, upstream]) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close(sanitizeCloseCode(code), reason.slice(0, 120));
        } catch {
          // already closing
        }
      }
    }
  };

  const forward = (to: WebSocket) => (ev: MessageEvent) => {
    try {
      to.send(ev.data);
    } catch {
      teardown(1011, "gate forward failed");
    }
  };
  for (const data of backlog) upstream.send(data);
  backlog.length = 0;
  client.addEventListener("message", forward(upstream));
  upstream.addEventListener("message", forward(client));
  client.addEventListener("close", (ev) => teardown(ev.code || 1000, ev.reason ?? ""));
  upstream.addEventListener("close", (ev) => teardown(ev.code || 1000, ev.reason ?? ""));
  client.addEventListener("error", () => teardown(1011, "client ws error"));
  upstream.addEventListener("error", () => teardown(1011, "upstream ws error"));
}

async function proxyHttp(req: Request, targetBase: string, path: string): Promise<Response> {
  try {
    const res = await fetch(new URL(path, targetBase), {
      method: req.method,
      headers: forwardableHeaders(req.headers),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    });
    return new Response(res.body, {
      status: res.status,
      headers: forwardableHeaders(res.headers),
    });
  } catch (e) {
    debug("http proxy error", (e as Error).message);
    return new Response("upstream unavailable", { status: 502 });
  }
}

function proxyWebSocket(req: Request, targetBase: string, path: string): {
  response: Response;
  socket: WebSocket;
} {
  const requestedProtocols = req.headers.get("sec-websocket-protocol");
  const { socket, response } = Deno.upgradeWebSocket(
    req,
    requestedProtocols ? { protocol: requestedProtocols.split(",")[0].trim() } : {},
  );
  // Buffer client data while the upstream dial is in flight; pumpWebSockets
  // flushes before attaching its own listener (same task, no gap).
  const backlog: (string | ArrayBuffer)[] = [];
  const buffer = (ev: MessageEvent) => backlog.push(ev.data);
  socket.addEventListener("message", buffer);
  socket.addEventListener("open", () => {
    const wsUrl = new URL(path, targetBase);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    const upstream = requestedProtocols
      ? new WebSocket(wsUrl, requestedProtocols.split(",").map((s) => s.trim()))
      : new WebSocket(wsUrl);
    upstream.addEventListener("open", () => {
      socket.removeEventListener("message", buffer);
      pumpWebSockets(socket, upstream, backlog);
    });
    upstream.addEventListener("error", () => {
      try {
        socket.close(1011, "upstream dial failed");
      } catch {
        // already closed
      }
    });
  });
  return { response, socket };
}

export function startGate(options: GateOptions): Gate {
  const hostname = options.hostname ?? "0.0.0.0";
  const liveByTicket = new Map<string, Set<WebSocket>>();

  const track = (ticketId: string, socket: WebSocket) => {
    let set = liveByTicket.get(ticketId);
    if (!set) liveByTicket.set(ticketId, set = new Set());
    set.add(socket);
    socket.addEventListener("close", () => {
      set.delete(socket);
      if (set.size === 0) liveByTicket.delete(ticketId);
    });
  };

  // Revocation sweep: piggyback on the store's hot-reload — poll live tickets
  // and close sockets whose ticket flipped to revoked. Cheap (only runs while
  // gated sockets exist).
  const sweep = setInterval(async () => {
    if (liveByTicket.size === 0) return;
    const records = await options.store.list();
    for (const [ticketId, sockets] of liveByTicket) {
      const record = records.find((r) => r.id === ticketId);
      if (record && !record.revokedAt) continue;
      for (const socket of [...sockets]) {
        try {
          socket.close(CLOSE_TICKET_REVOKED, "ticket revoked");
        } catch {
          // already closing
        }
      }
      liveByTicket.delete(ticketId);
    }
  }, 2000);

  const server = Deno.serve(
    { hostname, port: options.port, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      const isUpgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
      const targetBase = options.target();

      if (options.mode === "open") {
        const path = url.pathname + url.search;
        return isUpgrade
          ? proxyWebSocket(req, targetBase, path).response
          : proxyHttp(req, targetBase, path);
      }

      // Ticket mode.
      if (url.pathname === "/health" && !isUpgrade) {
        return proxyHttp(req, targetBase, "/health");
      }
      const match = url.pathname.match(TICKET_PATH);
      if (!match) return new Response("not found", { status: 404 });
      const [, secret, rest] = match;
      const verdict = await options.store.verify(secret);
      if (verdict.status !== "valid") {
        debug("rejected", verdict.status, url.pathname.slice(0, 24));
        return unauthorized();
      }
      const path = (rest || "/") + url.search;
      debug(isUpgrade ? "ws" : req.method, path, "ticket", verdict.record.id);
      if (isUpgrade) {
        const { response, socket } = proxyWebSocket(req, targetBase, path);
        track(verdict.record.id, socket);
        return response;
      }
      return proxyHttp(req, targetBase, path);
    },
  );

  const port = (server.addr as Deno.NetAddr).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stats: () =>
      [...liveByTicket.entries()].map(([ticketId, sockets]) => ({
        ticketId,
        connections: sockets.size,
      })),
    close: async () => {
      clearInterval(sweep);
      await server.shutdown();
    },
  };
}
