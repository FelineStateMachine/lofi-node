// createSyncNode — the one constructor. Consumer vocabulary is app, storage,
// upstream, pairing, status; iroh/dlopen/tunnel/jazz-napi stay internal.

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
import { loadOrCreateIrohKey, type UpstreamConfig } from "./config.ts";
import { MeshUnavailableError } from "./errors.ts";

export interface SyncNodeOptions {
  appId: string;
  backendSecret: string;
  adminSecret: string;
  /** Omit (or set inMemory) for an ephemeral node — tests, throwaway relays. */
  dataDir?: string;
  inMemory?: boolean;
  /** Browser-facing Jazz WebSocket port; auto-allocated when omitted. */
  listen?: { port?: number };
  /** "none" (default) | direct URL (e.g. Jazz Cloud) | peer ticket over iroh. */
  upstream?: UpstreamConfig;
  /** "auto": bring up iroh if the dylib resolves; stay up without it unless a
   * peer upstream NEEDS it. "off": plain Jazz server, dylib never loaded. */
  mesh?: "auto" | "off";
  allowLocalFirstAuth?: boolean;
  /** Explicit addon path (otherwise LOFI_NODE_IROH / in-repo build). */
  irohLibPath?: string;
}

export type MeshStatus =
  | { state: "up"; nodeId: string; ticket: string; connections: TunnelConnStat[] }
  | { state: "off" }
  | { state: "unavailable"; reason: string };

export interface SyncNodeStatus {
  appId: string;
  jazz: { url: string; port: number; storage: "persistent" | "memory" };
  upstream: UpstreamConfig;
  mesh: MeshStatus;
}

export interface SyncNode {
  /** Browser-facing Jazz WebSocket URL — what JAZZ_SERVER_URL points at. */
  url: string;
  port: number;
  appId: string;
  /** Pairing ticket for this node; throws MeshUnavailableError if mesh is down. */
  ticket(): string;
  /** Re-elect the upstream to a peer AT RUNTIME: swaps the tunnel and
   * restarts the embedded Jazz server on the SAME port, so browser clients
   * simply reconnect. Throws MeshUnavailableError if the mesh is down. */
  pair(peerTicket: string): Promise<void>;
  status(): SyncNodeStatus;
  stop(): Promise<void>;
}

export async function createSyncNode(options: SyncNodeOptions): Promise<SyncNode> {
  let upstream: UpstreamConfig = options.upstream ?? "none";
  const meshMode = options.mesh ?? "auto";
  const inMemory = options.inMemory ?? options.dataDir === undefined;

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
      const addon = loadIrohAddon(options.irohLibPath);
      const key = options.dataDir
        ? await loadOrCreateIrohKey(options.dataDir)
        : crypto.getRandomValues(new Uint8Array(32));
      irohNode = await IrohNode.open(addon, key);
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
      dataDir: options.dataDir ? `${options.dataDir}/jazz` : undefined,
      inMemory,
      upstreamUrl,
      allowLocalFirstAuth: options.allowLocalFirstAuth,
    });
  }

  // 3. Jazz server.
  let jazz: JazzHandle;
  const initial = resolveUpstream(upstream);
  tunnelListener = initial.listener;
  try {
    jazz = await startJazzFor(initial.url, options.listen?.port);
  } catch (e) {
    await initial.listener?.close();
    await irohNode?.close();
    throw e;
  }

  // 4. Inbound bridge: peers' tunnels land on our Jazz server.
  let acceptor: TunnelAcceptor | null = null;
  if (irohNode) {
    acceptor = runTunnelAcceptor(irohNode, jazz.url);
  }

  let stopped: Promise<void> | null = null;
  let pairing: Promise<void> | null = null;
  return {
    url: jazz.url,
    port: jazz.port,
    appId: options.appId,
    ticket: () => {
      if (!ticketString) {
        const reason = mesh.state === "unavailable" ? mesh.reason : "mesh is off";
        throw new MeshUnavailableError(reason);
      }
      return ticketString;
    },
    pair: (peerTicket: string) => {
      if (stopped) return Promise.reject(new Error("node is stopped"));
      if (pairing) return Promise.reject(new Error("a pair() is already in progress"));
      pairing = (async () => {
        try {
          const keptPort = jazz.port;
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
    status: () => ({
      appId: options.appId,
      jazz: { url: jazz.url, port: jazz.port, storage: inMemory ? "memory" : "persistent" },
      upstream,
      mesh: mesh.state === "up"
        ? {
          ...mesh,
          connections: [...(tunnelListener?.stats() ?? []), ...(acceptor?.stats() ?? [])],
        }
        : mesh,
    }),
    stop: () =>
      (stopped ??= (async () => {
        acceptor?.close();
        await tunnelListener?.close();
        await jazz.stop();
        await irohNode?.close();
      })()),
  };
}
