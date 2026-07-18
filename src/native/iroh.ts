// Deno.dlopen binding for the db-iroh-ffi flat C ABI — connections surface
// only (v1 needs node lifecycle + framed conn messages for the WS tunnel;
// docs/blobs/gossip/estore stay in reserve).
//
// Parking calls (accept, recv_msg, connect, node open/close) are declared
// `nonblocking` so they run on Deno's FFI thread pool and return Promises
// instead of stalling the isolate. This is safe by the crate's own design:
// send_msg posts to an unbounded writer-task channel (never parks) and uses
// locks disjoint from the recv path, and registry/poison state is per-handle.
// Known gap: a parked db_accept has NO cancellation — node close does not wake
// incoming.pop(). The daemon relies on process exit; see README reconciliation
// notes for the upstream fix (accept wake/timeout).

import { check, DB_OK } from "../errors.ts";
import { resolveIrohLib } from "./loader.ts";
import { MeshUnavailableError } from "../errors.ts";

export const IROH_ABI_VERSION = 1;

export const IROH_SYMBOLS = {
  db_iroh_abi_version: { parameters: [], result: "u32" },
  db_node_open: { parameters: ["buffer", "buffer"], result: "i32", nonblocking: true },
  db_node_id: { parameters: ["u64", "buffer"], result: "i32" },
  db_node_addr: { parameters: ["u64", "buffer"], result: "i32", nonblocking: true },
  db_add_addr: { parameters: ["u64", "buffer", "usize"], result: "i32" },
  db_node_close: { parameters: ["u64"], result: "i32", nonblocking: true },
  db_connect: { parameters: ["u64", "buffer", "usize", "buffer"], result: "i32", nonblocking: true },
  db_accept: { parameters: ["u64", "buffer"], result: "i32", nonblocking: true },
  db_conn_send_msg: { parameters: ["u64", "buffer", "usize"], result: "i32" },
  db_conn_recv_msg: { parameters: ["u64", "buffer"], result: "i32", nonblocking: true },
  db_conn_close: { parameters: ["u64"], result: "i32", nonblocking: true },
  db_buf_free: { parameters: [{ struct: ["pointer", "usize"] }], result: "void" },
} as const satisfies Deno.ForeignLibraryInterface;

export type IrohLib = Deno.DynamicLibrary<typeof IROH_SYMBOLS>;

/** Read a by-value DbBuf { ptr: u64, len: u64 } out-param: copy the foreign
 * bytes into owned memory, then free the Rust allocation. */
export function readDbBuf(lib: IrohLib, structBytes: Uint8Array): Uint8Array {
  const view = new DataView(structBytes.buffer, structBytes.byteOffset, 16);
  const ptr = view.getBigUint64(0, true);
  const len = Number(view.getBigUint64(8, true));
  let copy = new Uint8Array(0);
  if (ptr !== 0n && len > 0) {
    const foreign = Deno.UnsafePointerView.getArrayBuffer(Deno.UnsafePointer.create(ptr)!, len);
    copy = new Uint8Array(foreign).slice();
  }
  lib.symbols.db_buf_free(structBytes);
  return copy;
}

export function newDbBufStruct(): Uint8Array {
  return new Uint8Array(16);
}

/** dlopen + ABI handshake. Throws MeshUnavailableError with a precise reason
 * (no silent degradation — mirrors lofi's boot-gate ethos). */
export function openIrohLib(explicitPath?: string): IrohLib {
  const resolved = resolveIrohLib(explicitPath);
  if (resolved.status === "unsupported-platform") {
    throw new MeshUnavailableError(`no db-iroh-ffi build for ${resolved.platform}`);
  }
  if (resolved.status === "not-found") {
    throw new MeshUnavailableError(
      `dylib not found; tried: ${resolved.tried.join(", ")} (set LOFI_NODE_IROH)`,
    );
  }
  let lib: IrohLib;
  try {
    lib = Deno.dlopen(resolved.path, IROH_SYMBOLS);
  } catch (e) {
    throw new MeshUnavailableError(`dlopen failed for ${resolved.path}: ${(e as Error).message}`);
  }
  const abi = lib.symbols.db_iroh_abi_version();
  if (abi !== IROH_ABI_VERSION) {
    lib.close();
    throw new MeshUnavailableError(
      `ABI version mismatch: dylib=${abi}, expected=${IROH_ABI_VERSION}`,
    );
  }
  return lib;
}

export { check, DB_OK };
