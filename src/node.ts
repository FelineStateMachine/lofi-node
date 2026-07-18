// createSyncNode — the one constructor. Consumer vocabulary is app, storage,
// upstream, pairing, status; iroh/dlopen/tunnel/jazz-napi stay internal.

import { loadIrohAddon } from "./native/addon.ts";
import { IrohNode } from "./iroh/node.ts";
import { runTunnelAcceptor, startTunnelListener, type TunnelAcceptor, type TunnelListener } from "./tunnel.ts";
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
  | { state: "up"; nodeId: string; ticket: string }
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
  status(): SyncNodeStatus;
  stop(): Promise<void>;
}

export async function createSyncNode(options: SyncNodeOptions): Promise<SyncNode> {
  const upstream: UpstreamConfig = options.upstream ?? "none";
  const meshMode = options.mesh ?? "auto";
  const inMemory = options.inMemory ?? options.dataDir === undefined;

  // 1. Mesh (iroh) — optional unless the upstream election requires it.
  let mesh: MeshStatus = { state: "off" };
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
  let upstreamUrl: string | undefined;
  let tunnelListener: TunnelListener | null = null;
  if (upstream !== "none" && "url" in (upstream as object)) {
    upstreamUrl = (upstream as { url: string }).url;
  } else if (upstream !== "none" && "peer" in (upstream as object)) {
    const ticket = (upstream as { peer: string }).peer;
    if (!irohNode) {
      const reason = mesh.state === "unavailable" ? mesh.reason : "mesh is off";
      throw new MeshUnavailableError(`peer upstream requires the mesh: ${reason}`);
    }
    tunnelListener = startTunnelListener(irohNode, ticket);
    upstreamUrl = `ws://127.0.0.1:${tunnelListener.port}`;
  }

  // 3. Jazz server.
  let jazz: JazzHandle;
  try {
    jazz = await startJazz({
      appId: options.appId,
      backendSecret: options.backendSecret,
      adminSecret: options.adminSecret,
      port: options.listen?.port,
      dataDir: options.dataDir ? `${options.dataDir}/jazz` : undefined,
      inMemory,
      upstreamUrl,
      allowLocalFirstAuth: options.allowLocalFirstAuth,
    });
  } catch (e) {
    await tunnelListener?.close();
    await irohNode?.close();
    throw e;
  }

  // 4. Inbound bridge: peers' tunnels land on our Jazz server.
  let acceptor: TunnelAcceptor | null = null;
  if (irohNode) {
    acceptor = runTunnelAcceptor(irohNode, jazz.url);
  }

  let stopped: Promise<void> | null = null;
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
    status: () => ({
      appId: options.appId,
      jazz: { url: jazz.url, port: jazz.port, storage: inMemory ? "memory" : "persistent" },
      upstream,
      mesh,
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
