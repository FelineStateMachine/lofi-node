// Typed adapter over the vendored iroh-js addon, preserving the contract the
// tunnel and fixtures were built against: IrohNode open/ticket/connect/accept
// /close, IrohConn sendMsg/recvMsg/close (recvMsg → null at end of stream).
//
// One bi-stream per connection carries the framed messages (lofi_ext
// writeFrame/readFrame). The bi-stream is LAZY: QUIC acceptBi only resolves
// when the dialer's first bytes arrive, so accept() must return at the
// connection level or one silent dialer stalls the accept loop; first
// sendMsg/recvMsg resolves the stream instead. accept() resolves null when
// the endpoint closes — the acceptor loop's clean exit (proven at gate 0).

import type { BiStream, Connection, Endpoint, IrohAddon } from "../native/addon.ts";

const ALPN = [...new TextEncoder().encode("lofi-node/0")];

export class IrohConn {
  #addon: IrohAddon;
  #conn: Connection;
  #biFactory: () => Promise<BiStream>;
  #bi: Promise<BiStream> | null = null;
  #sendChain: Promise<void> = Promise.resolve();
  #sendFailed = false;
  #closed = false;

  constructor(addon: IrohAddon, conn: Connection, biFactory: () => Promise<BiStream>) {
    this.#addon = addon;
    this.#conn = conn;
    this.#biFactory = biFactory;
  }

  #stream(): Promise<BiStream> {
    return (this.#bi ??= this.#biFactory());
  }

  /** Post one framed message. Returns void (contract): frames are chained in
   * call order; a write failure marks the conn dead and closes it, which the
   * peer and our recv loop observe as end-of-stream. */
  sendMsg(bytes: Uint8Array): void {
    if (this.#closed || this.#sendFailed) throw new Error("conn is closed");
    this.#sendChain = this.#sendChain
      .then(async () => {
        const bi = await this.#stream();
        await this.#addon.writeFrame(bi.send, bytes);
      })
      .catch(() => {
        this.#sendFailed = true;
        this.close().catch(() => {});
      });
  }

  /** Await the next framed message; null once the stream ends. */
  async recvMsg(): Promise<Uint8Array | null> {
    if (this.#closed) return null;
    try {
      const bi = await this.#stream();
      const frame = await this.#addon.readFrame(bi.recv, null);
      return frame === null ? null : new Uint8Array(frame);
    } catch {
      // Mid-frame death or closed conn: end-of-stream for the caller.
      return null;
    }
  }

  stats(): { rtt: number | null; paths: number } {
    try {
      return { rtt: this.#conn.rtt(), paths: this.#conn.paths().length };
    } catch {
      return { rtt: null, paths: 0 };
    }
  }

  /** Idempotent. Flushes queued frames (bounded) before closing. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.race([this.#sendChain, new Promise((r) => setTimeout(r, 3000))]);
    if (this.#bi !== null) {
      try {
        const bi = await this.#bi;
        await bi.send.finish();
      } catch {
        // stream never opened or already finished/reset
      }
    }
    try {
      this.#conn.close(0n, []);
    } catch {
      // already closed
    }
  }
}

export class IrohNode {
  #addon: IrohAddon;
  #endpoint: Endpoint;
  #closed = false;

  private constructor(addon: IrohAddon, endpoint: Endpoint) {
    this.#addon = addon;
    this.#endpoint = endpoint;
  }

  static async open(addon: IrohAddon, secretKey: Uint8Array): Promise<IrohNode> {
    if (secretKey.length !== 32) throw new Error("iroh secret key must be 32 bytes");
    const builder = addon.Endpoint.builder();
    builder.applyN0();
    builder.secretKey([...secretKey]);
    builder.alpns([ALPN]);
    return new IrohNode(addon, await builder.bind());
  }

  idString(): string {
    return this.#endpoint.id().toString();
  }

  /** Pairing ticket (upstream EndpointTicket string). Waits briefly for the
   * endpoint to learn dialable addresses (direct or relay). */
  async ticket(): Promise<string> {
    for (let i = 0; i < 100; i++) {
      const addr = this.#endpoint.addr();
      if (addr.directAddresses().length > 0 || addr.relayUrl() !== null) {
        return this.#addon.EndpointTicket.fromAddr(addr).toString();
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("endpoint has no dialable addresses after 10s");
  }

  /** Dial a peer by its ticket. */
  async connect(ticket: string): Promise<IrohConn> {
    const addr = this.#addon.EndpointTicket.fromString(ticket).endpointAddr();
    const conn = await this.#endpoint.connect(addr, ALPN);
    return new IrohConn(this.#addon, conn, () => conn.openBi());
  }

  /** Await the next inbound connection; null when the endpoint closes (the
   * acceptor loop's clean exit). */
  async accept(): Promise<IrohConn | null> {
    const incoming = await this.#endpoint.acceptNext();
    if (incoming === null) return null;
    const conn = await (await incoming.accept()).connect();
    return new IrohConn(this.#addon, conn, () => conn.acceptBi());
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#endpoint.close();
  }
}
