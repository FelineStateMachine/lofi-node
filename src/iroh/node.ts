// Typed wrappers over the connections surface: one class per C handle,
// idempotent close, poison contract surfaced as IrohPoisonedError.

import {
  check,
  DB_OK,
  type IrohLib,
  newDbBufStruct,
  readDbBuf,
} from "../native/iroh.ts";
import { DB_ERR_BAD_HANDLE, DB_ERR_IO, IrohPoisonedError } from "../errors.ts";

export class IrohConn {
  #lib: IrohLib;
  #handle: bigint;
  #closed = false;

  constructor(lib: IrohLib, handle: bigint) {
    this.#lib = lib;
    this.#handle = handle;
  }

  /** Post one framed message. Never parks: frames feed the crate's writer task. */
  sendMsg(bytes: Uint8Array): void {
    check(
      this.#lib.symbols.db_conn_send_msg(this.#handle, bytes, BigInt(bytes.length)),
      "conn_send_msg",
    );
  }

  /** Await the next framed message; null once the connection is closed/ended.
   * Parks an FFI-pool thread, not the isolate. */
  async recvMsg(): Promise<Uint8Array | null> {
    const out = newDbBufStruct();
    const code = await this.#lib.symbols.db_conn_recv_msg(this.#handle, out);
    if (code === DB_OK) return readDbBuf(this.#lib, out);
    if (code === DB_ERR_IO || code === DB_ERR_BAD_HANDLE) return null;
    check(code, "conn_recv_msg");
    return null;
  }

  /** Idempotent. Wakes a parked recvMsg on this conn (per-handle registry). */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const code = await this.#lib.symbols.db_conn_close(this.#handle);
    if (code !== DB_OK && code !== DB_ERR_BAD_HANDLE) check(code, "conn_close");
  }
}

export class IrohNode {
  #lib: IrohLib;
  #handle: bigint;
  #closed = false;

  private constructor(lib: IrohLib, handle: bigint) {
    this.#lib = lib;
    this.#handle = handle;
  }

  static async open(lib: IrohLib, secretKey: Uint8Array): Promise<IrohNode> {
    if (secretKey.length !== 32) throw new Error("iroh secret key must be 32 bytes");
    const out = new BigUint64Array(1);
    const outBytes = new Uint8Array(out.buffer);
    check(await lib.symbols.db_node_open(secretKey, outBytes), "node_open");
    return new IrohNode(lib, out[0]);
  }

  id(): Uint8Array {
    const id = new Uint8Array(32);
    check(this.#lib.symbols.db_node_id(this.#handle, id), "node_id");
    return id;
  }

  /** Dialable postcard-encoded EndpointAddr (what tickets carry). */
  async addr(): Promise<Uint8Array> {
    const out = newDbBufStruct();
    check(await this.#lib.symbols.db_node_addr(this.#handle, out), "node_addr");
    return readDbBuf(this.#lib, out);
  }

  /** Seed a peer address so connect can dial without discovery. */
  addAddr(addrBytes: Uint8Array): void {
    check(
      this.#lib.symbols.db_add_addr(this.#handle, addrBytes, BigInt(addrBytes.length)),
      "add_addr",
    );
  }

  async connect(addrBytes: Uint8Array): Promise<IrohConn> {
    const out = new BigUint64Array(1);
    check(
      await this.#lib.symbols.db_connect(
        this.#handle,
        addrBytes,
        BigInt(addrBytes.length),
        new Uint8Array(out.buffer),
      ),
      "connect",
    );
    return new IrohConn(this.#lib, out[0]);
  }

  /** Await the next inbound connection. KNOWN GAP: not woken by close() —
   * callers must treat a daemon-lifetime accept loop as process-scoped. */
  async accept(): Promise<IrohConn> {
    const out = new BigUint64Array(1);
    check(await this.#lib.symbols.db_accept(this.#handle, new Uint8Array(out.buffer)), "accept");
    return new IrohConn(this.#lib, out[0]);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const code = await this.#lib.symbols.db_node_close(this.#handle);
    if (code !== DB_OK && code !== DB_ERR_BAD_HANDLE) check(code, "node_close");
  }
}

export { IrohPoisonedError };
