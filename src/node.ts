// createSyncNode — the one constructor. Consumer vocabulary is app, storage,
// upstream, pairing, access, status; iroh/dlopen/tunnel/jazz-napi/gate stay
// internal.

import { loadIrohAddon } from "./native/addon.ts";
import { IrohNode } from "./iroh/node.ts";
import {
  runTunnelAcceptor,
  startTunnelListener,
  type TunnelAcceptor,
  type TunnelConnStat,
  type TunnelListener,
} from "./tunnel.ts";
import { type JazzHandle, startJazz } from "./jazz.ts";
import {
  loadOrCreateIrohKey,
  type RelayConfig,
  type StorageConfig,
  type UpstreamConfig,
  validateRelay,
  validateStorage,
} from "./config.ts";
import { type Gate, startGate } from "./gate.ts";
import {
  type AppTicketRecord,
  AppTicketStore,
  encodeAppTicket,
  isRevokedByLineage,
} from "./appticket.ts";
import { MeshUnavailableError } from "./errors.ts";

/** Options for {@link createSyncNode}. */
export interface SyncNodeOptions {
  /** Jazz app id (a UUID). */
  appId: string;
  /** Jazz backend secret. */
  backendSecret: string;
  /** Jazz admin secret; in ticket mode the gate injects it server-side and
   * it never transits clients. */
  adminSecret: string;
  /** Omit (or set inMemory) for an ephemeral node — tests, throwaway relays. */
  dataDir?: string;
  inMemory?: boolean;
  /** Public port (the gate's in ticket mode); auto-allocated when omitted. */
  listen?: { port?: number };
  /** "open" (library default — today's behavior): everything reaching the
   * port syncs. "ticket": only requests carrying an issued app-ticket secret
   * (/t/<secret>/… serverUrl base path) reach Jazz; CLI init defaults here. */
  access?: "open" | "ticket";
  /** Where node data lives; sqlite path may be any mounted location. */
  storage?: StorageConfig;
  /** Base URL embedded into issued app tickets (e.g. http://192.168.1.10:4802).
   * Defaults to the gate's local URL — fine for same-host, wrong for LAN. */
  publicUrl?: string;
  /** "none" (default) | direct URL (e.g. Jazz Cloud) | peer ticket over iroh. */
  upstream?: UpstreamConfig;
  /** "auto": bring up iroh if the dylib resolves; stay up without it unless a
   * peer upstream NEEDS it. "off": plain Jazz server, dylib never loaded. */
  mesh?: "auto" | "off";
  /** Relay election for the iroh endpoint: "n0" (default — the public
   * n0-computer relays, fine for dev/testing), { urls } for operator-run
   * relays, or "disabled" for direct connections only. Peers dial this node
   * via the relay named in its pairing ticket, so no matching config is
   * needed on the other side. */
  relay?: RelayConfig;
  allowLocalFirstAuth?: boolean;
  /** Explicit addon path (otherwise LOFI_NODE_IROH / in-repo build). */
  irohLibPath?: string;
}

/** iroh mesh state: up (with pairing ticket + live tunnel stats), off, or
 * unavailable with the precise reason (no silent degradation). */
export type MeshStatus =
  | { state: "up"; nodeId: string; ticket: string; connections: TunnelConnStat[] }
  | { state: "off" }
  | { state: "unavailable"; reason: string };

/** Public view of an issued app-connect ticket (never the secret). */
export interface AppTicketInfo {
  id: string;
  scope: "sync" | "provision";
  label?: string;
  /** Id of the ticket this one was derived from (scope-down exchange). */
  parentId?: string;
  createdAt: string;
  /** True when the ticket itself or any ancestor is revoked. */
  revoked: boolean;
}

/** Snapshot returned by {@link SyncNode.status}. */
export interface SyncNodeStatus {
  appId: string;
  access: "open" | "ticket";
  jazz: { url: string; port: number; storage: StorageConfig };
  tickets: AppTicketInfo[];
  upstream: UpstreamConfig;
  mesh: MeshStatus;
}

/** A running sync node — see {@link createSyncNode}. */
export interface SyncNode {
  /** Public URL — what JAZZ_SERVER_URL points at in open mode; in ticket mode
   * apps use a ticket's own /t/<secret> URL against this same host:port. */
  url: string;
  port: number;
  appId: string;
  /** Node-pairing ticket; throws MeshUnavailableError if mesh is down. */
  ticket(): string;
  /** Issue an app-connect ticket (ticket mode only). The returned string is
   * shown once — the secret is never stored, only its digest. scope
   * "provision" additionally unlocks store administration through the gate
   * (a strict superset of sync). */
  issueTicket(
    options?: { label?: string; publicBase?: string; scope?: "sync" | "provision" },
  ): Promise<{
    id: string;
    ticket: string;
  }>;
  /** Revoke by id: new connections 401 immediately; live gated sockets close
   * with 4001 within the sweep interval. */
  revokeTicket(id: string): Promise<boolean>;
  listTickets(): Promise<AppTicketInfo[]>;
  /** Re-elect the upstream to a peer AT RUNTIME. The public port never
   * changes. Throws MeshUnavailableError if the mesh is down. */
  pair(peerTicket: string): Promise<void>;
  status(): SyncNodeStatus;
  stop(): Promise<void>;
}

function toTicketInfo(record: AppTicketRecord, all: AppTicketRecord[]): AppTicketInfo {
  return {
    id: record.id,
    scope: record.scope ?? "sync",
    label: record.label,
    parentId: record.parentId,
    createdAt: record.createdAt,
    revoked: isRevokedByLineage(record, all),
  };
}

/** Fail fast with the offending path when a user-chosen storage location is
 * not writable (NAS/synced-volume friendliness; no silent degradation). */
async function probeWritable(path: string): Promise<void> {
  try {
    await Deno.mkdir(path, { recursive: true });
    const probe = `${path}/.lofi-write-probe`;
    await Deno.writeTextFile(probe, "probe");
    await Deno.remove(probe);
  } catch (e) {
    throw new Error(`storage path "${path}" is not writable: ${(e as Error).message}`);
  }
}

/**
 * Start a sync node: an embedded Jazz server, optional iroh mesh, and (in
 * ticket mode) the public access gate. The returned {@link SyncNode} is the
 * whole operational surface: tickets, pairing, status, stop.
 */
export async function createSyncNode(options: SyncNodeOptions): Promise<SyncNode> {
  let upstream: UpstreamConfig = options.upstream ?? "none";
  const meshMode = options.mesh ?? "auto";
  const access = options.access ?? "open";
  const relay: RelayConfig = options.relay ?? "n0";
  validateRelay(relay);

  // 0. Storage election. Back-compat: explicit storage wins, else today's
  // rules (inMemory flag / absent dataDir → memory).
  const storage: StorageConfig = options.storage ??
    (options.inMemory ?? options.dataDir === undefined ? { type: "memory" } : { type: "sqlite" });
  validateStorage(storage);
  let jazzDataDir: string | undefined;
  if (storage.type === "sqlite") {
    jazzDataDir = storage.path ??
      (options.dataDir ? `${options.dataDir}/jazz` : undefined);
    if (jazzDataDir === undefined) {
      throw new Error('storage {type:"sqlite"} needs a path (or a node dataDir)');
    }
    await probeWritable(jazzDataDir);
  }
  const inMemory = storage.type === "memory";

  // 1. Mesh (iroh) — optional unless the upstream election requires it.
  // Connections are attached at status() time (they live in the tunnels).
  let mesh:
    | { state: "up"; nodeId: string; ticket: string }
    | { state: "off" }
    | { state: "unavailable"; reason: string } = { state: "off" };
  let irohNode: IrohNode | null = null;
  let ticketString: string | null = null;
  if (meshMode === "auto") {
    try {
      const addon = await loadIrohAddon(options.irohLibPath);
      const key = options.dataDir
        ? await loadOrCreateIrohKey(options.dataDir)
        : crypto.getRandomValues(new Uint8Array(32));
      irohNode = await IrohNode.open(addon, key, relay);
      ticketString = await irohNode.ticket();
      mesh = { state: "up", nodeId: irohNode.idString(), ticket: ticketString };
    } catch (e) {
      if (e instanceof MeshUnavailableError) {
        mesh = { state: "unavailable", reason: e.message };
      } else {
        throw e;
      }
    }
  }

  // 2. Resolve the upstream election to a concrete URL for JazzServer.
  let tunnelListener: TunnelListener | null = null;
  function resolveUpstream(
    election: UpstreamConfig,
  ): { url: string | undefined; listener: TunnelListener | null } {
    if (election === "none") return { url: undefined, listener: null };
    if ("url" in (election as object)) {
      return { url: (election as { url: string }).url, listener: null };
    }
    const ticket = (election as { peer: string }).peer;
    if (!irohNode) {
      const reason = mesh.state === "unavailable" ? mesh.reason : "mesh is off";
      throw new MeshUnavailableError(`peer upstream requires the mesh: ${reason}`);
    }
    const listener = startTunnelListener(irohNode, ticket);
    return { url: `ws://127.0.0.1:${listener.port}`, listener };
  }

  function startJazzFor(upstreamUrl: string | undefined, port: number | undefined) {
    return startJazz({
      appId: options.appId,
      backendSecret: options.backendSecret,
      adminSecret: options.adminSecret,
      port,
      dataDir: jazzDataDir,
      inMemory,
      upstreamUrl,
      allowLocalFirstAuth: options.allowLocalFirstAuth,
    });
  }

  // 3. Jazz server. In ticket mode Jazz takes an ephemeral loopback port and
  // the gate owns the public one; in open mode Jazz gets the listen port
  // directly (today's exact behavior — JazzServer binds loopback-only, so
  // "open" remains same-host/reverse-proxy territory).
  const gated = access === "ticket";
  let jazz: JazzHandle;
  const initial = resolveUpstream(upstream);
  tunnelListener = initial.listener;
  try {
    jazz = await startJazzFor(initial.url, gated ? undefined : options.listen?.port);
  } catch (e) {
    await initial.listener?.close();
    await irohNode?.close();
    throw e;
  }
  if (new URL(jazz.url.replace(/^ws/, "http")).hostname !== "127.0.0.1") {
    // The gate's enforcement assumes Jazz is loopback-only (true at
    // alpha.53); a future alpha binding wider would need a firewall note.
    console.warn(`lofi-node: JazzServer bound ${jazz.url}, expected loopback`);
  }

  // 3b. App tickets + gate (ticket mode).
  const ticketStore = await AppTicketStore.load(options.dataDir);
  let gate: Gate | null = null;
  if (gated) {
    gate = startGate({
      port: options.listen?.port ?? 0,
      target: () => jazz.url.replace(/^ws/, "http"),
      mode: "ticket",
      store: ticketStore,
      appId: options.appId,
      adminSecret: options.adminSecret,
      publicBase: options.publicUrl,
      nodeTicket: ticketString ?? undefined,
    });
  }

  // 4. Inbound bridge: peers' tunnels land directly on the INTERNAL Jazz URL
  // — paired peers are authenticated by possession of the node-pairing
  // ticket, so this is not a gate bypass.
  let acceptor: TunnelAcceptor | null = null;
  if (irohNode) {
    acceptor = runTunnelAcceptor(irohNode, jazz.url);
  }

  const publicPort = gate ? gate.port : jazz.port;
  const publicUrl = gate ? `ws://127.0.0.1:${gate.port}` : jazz.url;

  // status() is sync; keep a ticket snapshot refreshed by every ticket call
  // and opportunistically by status() itself (next call sees fresh state).
  const snapshotTickets = async () => {
    const records = await ticketStore.list();
    return records.map((record) => toTicketInfo(record, records));
  };
  let ticketSnapshot: AppTicketInfo[] = await snapshotTickets();
  const refreshTickets = async () => {
    ticketSnapshot = await snapshotTickets();
    return ticketSnapshot;
  };

  let stopped: Promise<void> | null = null;
  let pairing: Promise<void> | null = null;
  return {
    url: publicUrl,
    port: publicPort,
    appId: options.appId,
    ticket: () => {
      if (!ticketString) {
        const reason = mesh.state === "unavailable" ? mesh.reason : "mesh is off";
        throw new MeshUnavailableError(reason);
      }
      return ticketString;
    },
    issueTicket: async (ticketOptions = {}) => {
      if (!gate) throw new Error('issueTicket requires access: "ticket"');
      const scope = ticketOptions.scope ?? "sync";
      const { record, secret } = await ticketStore.issue(ticketOptions.label, scope);
      const base = (ticketOptions.publicBase ?? options.publicUrl ??
        `http://127.0.0.1:${gate.port}`).replace(/\/+$/, "");
      const ticket = encodeAppTicket({
        v: 1,
        appId: options.appId,
        url: `${base}/t/${secret}`,
        scope: scope === "provision" ? "provision" : undefined,
        label: ticketOptions.label,
        node: ticketString ?? undefined,
      });
      await refreshTickets();
      return { id: record.id, ticket };
    },
    revokeTicket: async (id: string) => {
      const revoked = (await ticketStore.revoke(id)) !== null;
      await refreshTickets();
      return revoked;
    },
    listTickets: () => refreshTickets(),
    pair: (peerTicket: string) => {
      if (stopped) return Promise.reject(new Error("node is stopped"));
      if (pairing) return Promise.reject(new Error("a pair() is already in progress"));
      pairing = (async () => {
        try {
          // In gated mode the public port belongs to the gate, so Jazz can
          // restart on a fresh ephemeral port; in open mode keep the port so
          // clients reconnect to an unchanged URL.
          const keptPort = gate ? undefined : jazz.port;
          // resolveUpstream throws (MeshUnavailableError) BEFORE teardown.
          const next = resolveUpstream({ peer: peerTicket });
          const oldListener = tunnelListener;
          tunnelListener = next.listener;
          await oldListener?.close();
          await jazz.stop();
          jazz = await startJazzFor(next.url, keptPort);
          upstream = { peer: peerTicket };
        } finally {
          pairing = null;
        }
      })();
      return pairing;
    },
    status: () => {
      refreshTickets().catch(() => {});
      return {
        appId: options.appId,
        access,
        jazz: { url: jazz.url, port: jazz.port, storage },
        tickets: ticketSnapshot,
        upstream,
        mesh: mesh.state === "up"
          ? {
            ...mesh,
            connections: [...(tunnelListener?.stats() ?? []), ...(acceptor?.stats() ?? [])],
          }
          : mesh,
      };
    },
    stop: () => (stopped ??= (async () => {
      acceptor?.close();
      await tunnelListener?.close();
      await gate?.close();
      await jazz.stop();
      await irohNode?.close();
    })()),
  };
}
