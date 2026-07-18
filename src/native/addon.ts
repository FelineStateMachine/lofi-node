// Load the vendored iroh-js napi addon (native/iroh-js) and type the subset
// lofi-node uses. The addon is upstream n0-computer/iroh-ffi's iroh-js crate
// plus the lofi_ext framing module — see native/iroh-js/UPSTREAM.md.
//
// NEVER call the watch APIs (watchAddr/watchPaths/…): at upstream v1.1.0 they
// panic outside a tokio context and ABORT the process under Deno.

import { createRequire } from "node:module";
import { MeshUnavailableError } from "../errors.ts";
import { resolveIrohLib } from "./loader.ts";
import { RELEASE_ARTIFACTS } from "./artifacts.ts";

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

/** Cache key for extracted artifacts — bump when the vendored tag or
 * lofi_ext surface changes (see native/iroh-js/UPSTREAM.md). */
export const IROH_JS_VERSION = "1.1.0-lofi.1";

function osCacheDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  switch (Deno.build.os) {
    case "darwin":
      return `${home}/Library/Caches`;
    case "windows":
      return Deno.env.get("LOCALAPPDATA") ?? `${home}/AppData/Local`;
    default:
      return Deno.env.get("XDG_CACHE_HOME") ?? `${home}/.cache`;
  }
}

/** Give require() a real on-disk .node file. Prefer a sibling shim next to
 * the artifact (dev flow: cargo output, refreshed on mtime). When the
 * artifact lives in a read-only place — a `deno compile` binary's embedded
 * vfs — extract to a version-keyed OS cache instead (atomic: tmp + rename,
 * safe under concurrent launches). */
function stageNodeArtifact(srcPath: string): string {
  if (srcPath.endsWith(".node")) return srcPath;
  const shim = srcPath.replace(/\.(dylib|so|dll)$/, ".node");
  try {
    const src = Deno.statSync(srcPath);
    let stale = true;
    try {
      const dst = Deno.statSync(shim);
      stale = (src.mtime?.getTime() ?? 1) > (dst.mtime?.getTime() ?? 0);
    } catch {
      // no shim yet
    }
    if (stale) Deno.copyFileSync(srcPath, shim);
    return shim;
  } catch {
    // Sibling not writable (embedded vfs / read-only install): cache extract.
  }
  const dir =
    `${osCacheDir()}/lofi-node/iroh-js-${IROH_JS_VERSION}-${Deno.build.os}-${Deno.build.arch}`;
  const target = `${dir}/iroh.node`;
  try {
    Deno.statSync(target);
    return target; // version-keyed: presence means done
  } catch {
    // extract below
  }
  Deno.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${Deno.pid}.tmp`;
  Deno.writeFileSync(tmp, Deno.readFileSync(srcPath));
  Deno.renameSync(tmp, target);
  return target;
}

/** Fetch the platform's addon from the GitHub release pinned by the
 * committed artifacts.ts, verify its sha256 against the in-package digest
 * (the JSR artifact pins the binaries it will accept), and stage it into the
 * version-keyed OS cache. This is how JSR consumers get the native layer —
 * the package itself ships no binaries. */
async function downloadReleaseArtifact(platform: string): Promise<string> {
  const asset = (RELEASE_ARTIFACTS.assets as Record<string, { file: string; sha256: string }>)[
    platform
  ];
  if (!asset) {
    throw new MeshUnavailableError(`no release artifact for ${platform}`);
  }
  const dir = `${osCacheDir()}/lofi-node/iroh-js-release-${RELEASE_ARTIFACTS.version}-${platform}`;
  const target = `${dir}/iroh.node`;
  try {
    Deno.statSync(target);
    return target; // version-keyed: verified at download time
  } catch {
    // download below
  }
  const url =
    `https://github.com/FelineStateMachine/lofi-node/releases/download/v${RELEASE_ARTIFACTS.version}/${asset.file}`;
  let bytes: Uint8Array;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    throw new MeshUnavailableError(
      `could not download native addon from ${url}: ${(e as Error).message}`,
    );
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (sha256 !== asset.sha256) {
    throw new MeshUnavailableError(
      `native addon checksum mismatch for ${asset.file}: got ${sha256.slice(0, 16)}…, ` +
        `expected ${asset.sha256.slice(0, 16)}… — refusing to load`,
    );
  }
  Deno.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${Deno.pid}.tmp`;
  Deno.writeFileSync(tmp, bytes);
  Deno.renameSync(tmp, target);
  return target;
}

/** Load + probe the addon. Resolution: env/explicit → cargo build output →
 * in-repo prebuilt → GitHub-release download (JSR consumers). Throws
 * MeshUnavailableError with a precise reason (no silent degradation —
 * lofi's boot-gate ethos). */
export async function loadIrohAddon(explicitPath?: string): Promise<IrohAddon> {
  const resolved = resolveIrohLib(explicitPath);
  if (resolved.status === "unsupported-platform") {
    throw new MeshUnavailableError(`no iroh-js build for ${resolved.platform}`);
  }
  // require() only loads native addons from `.node` files — cargo emits
  // .dylib/.so/.dll, and a compiled binary's embedded artifacts aren't
  // directly loadable at all; stage a real .node file either way.
  let loadPath: string;
  if (resolved.status === "not-found") {
    // Running from the JSR cache (no repo checkout): fetch the pinned
    // release artifact instead.
    const platform = `${Deno.build.os}-${Deno.build.arch}`;
    loadPath = await downloadReleaseArtifact(platform);
  } else {
    try {
      loadPath = stageNodeArtifact(resolved.path);
    } catch (e) {
      throw new MeshUnavailableError(
        `could not stage .node artifact for ${resolved.path}: ${(e as Error).message}`,
      );
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
    throw new MeshUnavailableError(`addon at ${loadPath} lacks the Endpoint surface`);
  }
  if (typeof addon.maxFrame !== "function" || typeof addon.writeFrame !== "function") {
    throw new MeshUnavailableError(
      `addon at ${loadPath} lacks lofi_ext framing — built from stock upstream?`,
    );
  }
  return addon;
}
