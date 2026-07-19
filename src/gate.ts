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

import {
  type AppTicketPop,
  type AppTicketStore,
  encodeAppTicket,
  hashSecret,
  importPopKey,
  isRevokedByLineage,
  popMessage,
  SECRET_LENGTH,
  verifyPopSignature,
} from "./appticket.ts";
import { forwardableHeaders, sanitizeCloseCode } from "./tunnel.ts";

const DEBUG = Deno.env.get("LOFI_NODE_DEBUG") === "1";
function debug(...args: unknown[]): void {
  if (DEBUG) console.error("[gate]", ...args);
}

/** WS close code sent when a ticket is revoked mid-session; the app should
 * surface re-enrollment (see docs/app-ticket.md). */
export const CLOSE_TICKET_REVOKED = 4001;

const TICKET_PATH = new RegExp(`^/t/([A-Za-z0-9_-]{${SECRET_LENGTH}})(/.*)?$`);
const CONNECT_PATH = new RegExp(`^/c/([A-Za-z0-9_-]{${SECRET_LENGTH}})(/.*)?$`);

/** How long an unanswered proof-of-possession challenge stays valid. */
const CHALLENGE_TTL_MS = 120_000;
/** Sliding lifetime of a connect token; refreshed on each authenticated use,
 * so a live sync session never expires mid-flight. Tokens are memory-only —
 * a node restart invalidates them and the client re-runs the exchange. */
const CONNECT_TOKEN_TTL_MS = 86_400_000;
/** Outstanding-challenge cap per ticket; the oldest is dropped past it. */
const MAX_CHALLENGES_PER_TICKET = 32;

type PopChallenge = { ticketId: string; nonce: string; expiresAt: number };
type ConnectToken = { ticketId: string; expiresAt: number };

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
  /** Base URL embedded into tickets minted by the derive endpoint (the
   * node's publicUrl); defaults to the gate's own loopback URL — same
   * election as CLI-issued tickets. */
  publicBase?: string;
  /** The node's iroh EndpointTicket, carried on derived tickets exactly like
   * node-issued ones. */
  nodeTicket?: string;
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

  // Proof-of-possession state, memory-only by design: challenges are
  // single-use with a short TTL, and connect tokens are stored hashed (the
  // node never stores secrets) with a sliding TTL.
  const challenges = new Map<string, PopChallenge>();
  const connectTokens = new Map<string, ConnectToken>();

  const base64urlNoPad = (bytes: Uint8Array): string => {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  };

  const mintChallenge = (ticketId: string): { id: string; nonce: string } => {
    const perTicket = [...challenges.entries()].filter(([, c]) => c.ticketId === ticketId);
    if (perTicket.length >= MAX_CHALLENGES_PER_TICKET) {
      let oldestId = perTicket[0][0];
      let oldestAt = perTicket[0][1].expiresAt;
      for (const [id, challenge] of perTicket) {
        if (challenge.expiresAt < oldestAt) {
          oldestAt = challenge.expiresAt;
          oldestId = id;
        }
      }
      challenges.delete(oldestId);
    }
    const id = base64urlNoPad(crypto.getRandomValues(new Uint8Array(12)));
    const nonce = base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
    challenges.set(id, { ticketId, nonce, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    return { id, nonce };
  };

  const answerChallenge = async (
    ticketId: string,
    pop: AppTicketPop,
    body: { id?: unknown; sig?: unknown },
  ): Promise<string | null> => {
    if (typeof body.id !== "string" || typeof body.sig !== "string") return null;
    const challenge = challenges.get(body.id);
    // Single-use: the challenge dies on its first answer attempt, valid or not.
    challenges.delete(body.id);
    if (!challenge || challenge.ticketId !== ticketId || challenge.expiresAt < Date.now()) {
      return null;
    }
    const verified = await verifyPopSignature(
      pop.spki,
      popMessage(options.appId, ticketId, challenge.nonce),
      body.sig,
    );
    if (!verified) return null;
    const token = base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
    connectTokens.set(await hashSecret(token), {
      ticketId,
      expiresAt: Date.now() + CONNECT_TOKEN_TTL_MS,
    });
    return token;
  };

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
    // Expired proof-of-possession state ages out regardless of connections.
    const now = Date.now();
    for (const [id, challenge] of challenges) {
      if (challenge.expiresAt < now) challenges.delete(id);
    }
    for (const [digest, token] of connectTokens) {
      if (token.expiresAt < now) connectTokens.delete(digest);
    }
    if (liveByTicket.size === 0 && connectTokens.size === 0 && challenges.size === 0) return;
    const records = await options.store.list();
    const dead = (ticketId: string): boolean => {
      const record = records.find((r) => r.id === ticketId);
      return !record || isRevokedByLineage(record, records);
    };
    for (const [id, challenge] of challenges) {
      if (dead(challenge.ticketId)) challenges.delete(id);
    }
    for (const [digest, token] of connectTokens) {
      if (dead(token.ticketId)) connectTokens.delete(digest);
    }
    for (const [ticketId, sockets] of liveByTicket) {
      if (!dead(ticketId)) continue;
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
      let strippedPath = rest || "/";
      // Possession-bound tickets: the bare secret opens only the
      // proof-of-possession exchange; everything else must ride a connect
      // token minted by a fresh signature from the bound device key. A stolen
      // ticket string alone therefore no longer connects.
      if (verdict.record.pop) {
        // Liveness stays reachable with the bare secret — it reveals nothing
        // a valid ticket holder could not learn from the open /health route.
        if (strippedPath === "/health" && !isUpgrade) {
          return proxyHttp(req, targetBase, "/health");
        }
        if (strippedPath === "/pop/challenge" && !isUpgrade) {
          if (req.method !== "POST") {
            return new Response("method not allowed", { status: 405 });
          }
          const challenge = mintChallenge(verdict.record.id);
          return new Response(
            JSON.stringify({
              v: 1,
              id: challenge.id,
              nonce: challenge.nonce,
              expiresIn: CHALLENGE_TTL_MS / 1000,
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (strippedPath === "/pop/answer" && !isUpgrade) {
          if (req.method !== "POST") {
            return new Response("method not allowed", { status: 405 });
          }
          let body: { id?: unknown; sig?: unknown } = {};
          try {
            body = await req.json() as { id?: unknown; sig?: unknown };
          } catch {
            // malformed body falls through to the single rejection path
          }
          const token = await answerChallenge(verdict.record.id, verdict.record.pop, body);
          if (token === null) {
            debug("rejected pop answer", verdict.record.id);
            return unauthorized();
          }
          debug("pop verified", verdict.record.id);
          return new Response(
            JSON.stringify({ v: 1, connect: token, expiresIn: CONNECT_TOKEN_TTL_MS / 1000 }),
            { headers: { "content-type": "application/json" } },
          );
        }
        const connect = strippedPath.match(CONNECT_PATH);
        if (!connect) {
          debug("rejected pop-bound bare path", verdict.record.id);
          return unauthorized();
        }
        const [, connectSecret, connectRest] = connect;
        const tokenDigest = await hashSecret(connectSecret);
        const token = connectTokens.get(tokenDigest);
        if (!token || token.ticketId !== verdict.record.id || token.expiresAt < Date.now()) {
          debug("rejected connect token", verdict.record.id);
          return unauthorized();
        }
        // Sliding lifetime: each authenticated use extends the token.
        token.expiresAt = Date.now() + CONNECT_TOKEN_TTL_MS;
        strippedPath = connectRest || "/";
      } else if (strippedPath.startsWith("/pop/")) {
        // The exchange only exists for bound tickets; a bearer ticket probing
        // it is a client-configuration error, and the path must never leak
        // upstream.
        return new Response(JSON.stringify({ error: "pop_not_bound" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (strippedPath === "/store-status" && !isUpgrade) {
        return storeStatus(targetBase, options.appId, options.adminSecret);
      }
      // Scope-down exchange: a provision ticket mints a derived sync ticket
      // (the lofi app persists that one at rest, keeping the provision ticket
      // sealed or memory-only). The derived record carries parentId, so
      // revoking the provision ticket kills its derived tickets too. A sync
      // ticket gets the SAME 401 as an invalid one (nothing to enumerate).
      if (strippedPath === "/derive-sync-ticket" && !isUpgrade) {
        if (scope !== "provision") {
          debug("rejected sync-scope on derive", verdict.record.id);
          return unauthorized();
        }
        if (req.method !== "POST") {
          return new Response("method not allowed", { status: 405 });
        }
        let requested: string | undefined;
        let deviceKey: { alg?: unknown; spki?: unknown } | undefined;
        try {
          const body = await req.json() as { label?: unknown; devicePublicKey?: unknown };
          if (typeof body.label === "string") requested = body.label;
          if (typeof body.devicePublicKey === "object" && body.devicePublicKey !== null) {
            deviceKey = body.devicePublicKey as { alg?: unknown; spki?: unknown };
          }
        } catch {
          // empty or non-JSON body: fall through to the default label
        }
        // An offered device key binds the derived ticket to possession. A
        // malformed key is a client bug, not an auth probe — 400, not 401.
        let pop: { alg: "ES256"; spki: string } | undefined;
        if (deviceKey !== undefined) {
          if (deviceKey.alg !== "ES256" || typeof deviceKey.spki !== "string") {
            return new Response(JSON.stringify({ error: "invalid_device_key" }), {
              status: 400,
              headers: { "content-type": "application/json" },
            });
          }
          try {
            await importPopKey(deviceKey.spki);
          } catch {
            return new Response(JSON.stringify({ error: "invalid_device_key" }), {
              status: 400,
              headers: { "content-type": "application/json" },
            });
          }
          pop = { alg: "ES256", spki: deviceKey.spki };
        }
        const parent = verdict.record;
        const label = requested ?? `${parent.label ?? parent.id} (sync)`;
        const derived = await options.store.issue(label, "sync", parent.id, pop);
        const base = (options.publicBase ??
          `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`).replace(/\/+$/, "");
        const ticket = encodeAppTicket({
          v: 1,
          appId: options.appId,
          url: `${base}/t/${derived.secret}`,
          label,
          node: options.nodeTicket,
        });
        debug("derived sync ticket", derived.record.id, "from", parent.id, pop ? "pop" : "bearer");
        return new Response(
          JSON.stringify({
            v: 1,
            id: derived.record.id,
            ticket,
            ...(pop ? { pop: true } : {}),
          }),
          { headers: { "content-type": "application/json" } },
        );
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
