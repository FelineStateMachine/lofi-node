// Load the vendored iroh-js napi addon (native/iroh-js) and type the subset
// lofi-node uses. The addon is upstream n0-computer/iroh-ffi's iroh-js crate
// plus the lofi_ext framing module — see native/iroh-js/UPSTREAM.md.
//
// NEVER call the watch APIs (watchAddr/watchPaths/…): at upstream v1.1.0 they
// panic outside a tokio context and ABORT the process under Deno.

import { createRequire } from "node:module";
import { MeshUnavailableError } from "../errors.ts";
import { resolveIrohLib } from "./loader.ts";

export interface SecretKey {
  toBytes(): number[];
  public(): EndpointId;
}

export interface EndpointId {
  toString(): string;
  equals(other: EndpointId): boolean;
}

export interface EndpointAddr {
  id(): EndpointId;
  directAddresses(): string[];
  relayUrl(): string | null;
  toString(): string;
}

export interface EndpointTicket {
  endpointAddr(): EndpointAddr;
  toString(): string;
}

export interface SendStream {
  finish(): Promise<void>;
}

export interface RecvStream {
  stop(errorCode: bigint): Promise<void>;
}

export interface BiStream {
  readonly send: SendStream;
  readonly recv: RecvStream;
}

export interface ConnectionStats {
  [key: string]: unknown;
}

export interface PathSnapshot {
  [key: string]: unknown;
}

export interface Connection {
  remoteId(): EndpointId;
  openBi(): Promise<BiStream>;
  acceptBi(): Promise<BiStream>;
  close(errorCode: bigint, reason: number[]): void;
  rtt(): number | null;
  stats(): ConnectionStats;
  paths(): PathSnapshot[];
}

export interface Accepting {
  connect(): Promise<Connection>;
}

export interface Incoming {
  accept(): Promise<Accepting>;
}

export interface Endpoint {
  id(): EndpointId;
  addr(): EndpointAddr;
  connect(addr: EndpointAddr, alpn: number[]): Promise<Connection>;
  acceptNext(): Promise<Incoming | null>;
  close(): Promise<void>;
  isClosed(): boolean;
}

export interface EndpointBuilder {
  applyN0(): void;
  applyN0DisableRelay(): void;
  secretKey(bytes: number[]): void;
  alpns(alpns: number[][]): void;
  bind(): Promise<Endpoint>;
}

export interface IrohAddon {
  Endpoint: { builder(): EndpointBuilder };
  EndpointTicket: {
    fromAddr(addr: EndpointAddr): EndpointTicket;
    fromString(s: string): EndpointTicket;
  };
  SecretKey: { fromBytes(bytes: number[]): SecretKey; generate(): SecretKey };
  // lofi_ext
  writeFrame(stream: SendStream, data: Uint8Array): Promise<void>;
  readFrame(stream: RecvStream, max?: number | null): Promise<Uint8Array | null>;
  maxFrame(): number;
}

const require = createRequire(import.meta.url);

/** Load + probe the addon. Throws MeshUnavailableError with a precise reason
 * (no silent degradation — lofi's boot-gate ethos). */
export function loadIrohAddon(explicitPath?: string): IrohAddon {
  const resolved = resolveIrohLib(explicitPath);
  if (resolved.status === "unsupported-platform") {
    throw new MeshUnavailableError(`no iroh-js build for ${resolved.platform}`);
  }
  if (resolved.status === "not-found") {
    throw new MeshUnavailableError(
      `iroh-js addon not found; tried: ${resolved.tried.join(", ")} — build with ` +
        `\`cargo build --release\` in native/iroh-js, or set LOFI_NODE_IROH`,
    );
  }
  // require() only loads native addons from `.node` files — cargo emits
  // .dylib/.so/.dll, so maintain a sibling .node copy (refreshed on mtime).
  let loadPath = resolved.path;
  if (!loadPath.endsWith(".node")) {
    const shim = loadPath.replace(/\.(dylib|so|dll)$/, ".node");
    try {
      const src = Deno.statSync(loadPath);
      let stale = true;
      try {
        const dst = Deno.statSync(shim);
        stale = (src.mtime?.getTime() ?? 1) > (dst.mtime?.getTime() ?? 0);
      } catch {
        // no shim yet
      }
      if (stale) Deno.copyFileSync(loadPath, shim);
      loadPath = shim;
    } catch (e) {
      throw new MeshUnavailableError(`could not stage .node shim for ${loadPath}: ${(e as Error).message}`);
    }
  }
  let addon: IrohAddon;
  try {
    addon = require(loadPath) as IrohAddon;
  } catch (e) {
    throw new MeshUnavailableError(`addon load failed for ${loadPath}: ${(e as Error).message}`);
  }
  // Probe: core surface + the lofi_ext marker prove this is OUR build, not a
  // stock upstream artifact.
  if (typeof addon.Endpoint?.builder !== "function") {
    throw new MeshUnavailableError(`addon at ${resolved.path} lacks the Endpoint surface`);
  }
  if (typeof addon.maxFrame !== "function" || typeof addon.writeFrame !== "function") {
    throw new MeshUnavailableError(
      `addon at ${resolved.path} lacks lofi_ext framing — built from stock upstream?`,
    );
  }
  return addon;
}
