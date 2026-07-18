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

import { type AppTicketStore, SECRET_LENGTH } from "./appticket.ts";
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
  /** The node's Jazz app id + admin secret, for provision-scoped injection
   * and the store-status endpoint. The secret never transits the gate inbound
   * — client-supplied X-Jazz-Admin-Secret headers are stripped in ticket
   * mode; the gate injects config's own for provision-scoped requests. */
  appId: string;
  adminSecret: string;
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

async function proxyHttp(
  req: Request,
  targetBase: string,
  path: string,
  headerOverrides?: Record<string, string | null>,
): Promise<Response> {
  try {
    const headers = forwardableHeaders(req.headers);
    for (const [name, value] of Object.entries(headerOverrides ?? {})) {
      if (value === null) delete headers[name];
      else headers[name] = value;
    }
    const res = await fetch(new URL(path, targetBase), {
      method: req.method,
      headers,
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

/** Node-served, metadata-only store preflight: lets a sync-scoped client
 * classify `no_schema` / hash-mismatch instead of hanging on writes (lofi#109
 * failure surface). Never returns schema contents, policies, or secrets. */
async function storeStatus(
  targetBase: string,
  appId: string,
  adminSecret: string,
): Promise<Response> {
  try {
    const admin = { "X-Jazz-Admin-Secret": adminSecret };
    const schemasRes = await fetch(new URL(`/apps/${appId}/schemas`, targetBase), {
      headers: admin,
    });
    if (!schemasRes.ok) {
      await schemasRes.body?.cancel();
      debug("store-status schemas fetch", schemasRes.status);
      return new Response(JSON.stringify({ error: "store_unavailable" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
    const body = await schemasRes.json() as {
      hashes?: string[];
      schemas?: { hash: string; publishedAt?: number | string }[];
    };
    // Head = newest published schema; the bare `hashes` array is NOT ordered.
    const entries = body.schemas ?? [];
    let headHash: string | undefined;
    let newest = -Infinity;
    for (const entry of entries) {
      const at = typeof entry.publishedAt === "string"
        ? Date.parse(entry.publishedAt)
        : entry.publishedAt ?? 0;
      if (at >= newest) {
        newest = at;
        headHash = entry.hash;
      }
    }
    const hashes = body.hashes ?? entries.map((e) => e.hash);
    headHash ??= hashes[hashes.length - 1];
    let permissionsHead: string | null = null;
    try {
      const headRes = await fetch(
        new URL(`/apps/${appId}/admin/permissions/head`, targetBase),
        { headers: admin },
      );
      if (headRes.ok) {
        permissionsHead = ((await headRes.json()) as { head?: string | null }).head ?? null;
      } else {
        await headRes.body?.cancel();
      }
    } catch {
      // permissions head stays null
    }
    const schema = hashes.length > 0
      ? { deployed: true, headHash, permissionsHead }
      : { deployed: false };
    return new Response(JSON.stringify({ v: 1, appId, schema }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    debug("store-status error", (e as Error).message);
    return new Response(JSON.stringify({ error: "store_unavailable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }
}

const ADMIN_PATH = /^\/apps\/[^/]+\/admin(\/|$)/;

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
        // Open nodes still serve the preflight so lofi's store classifier
        // works against dev setups.
        if (url.pathname === "/store-status" && !isUpgrade) {
          return storeStatus(targetBase, options.appId, options.adminSecret);
        }
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
      const scope = verdict.record.scope ?? "sync";
      const strippedPath = rest || "/";
      if (strippedPath === "/store-status" && !isUpgrade) {
        return storeStatus(targetBase, options.appId, options.adminSecret);
      }
      // Admin/catalogue-mutating routes need provision scope; a sync ticket
      // gets the SAME 401 shape as an invalid ticket (nothing to enumerate).
      if (ADMIN_PATH.test(strippedPath) && scope !== "provision") {
        debug("rejected sync-scope on admin path", verdict.record.id);
        return unauthorized();
      }
      const path = strippedPath + url.search;
      debug(isUpgrade ? "ws" : req.method, path, "ticket", verdict.record.id, scope);
      if (isUpgrade) {
        const { response, socket } = proxyWebSocket(req, targetBase, path);
        track(verdict.record.id, socket);
        return response;
      }
      // The admin secret only ever originates from the node: inbound headers
      // are stripped; provision-scoped requests get config's secret injected
      // (on catalogue reads too — the merge flow fetches the head schema
      // verbatim without ever holding the secret client-side).
      return proxyHttp(req, targetBase, path, {
        "x-jazz-admin-secret": scope === "provision" ? options.adminSecret : null,
      });
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
