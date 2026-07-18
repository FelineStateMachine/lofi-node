// @nzip/lofi-node — self-hostable Jazz sync node with iroh node-to-node
// transport. Private prove-out; see README for status and roadmap.

export { createSyncNode } from "./src/node.ts";
export type { MeshStatus, SyncNode, SyncNodeOptions, SyncNodeStatus } from "./src/node.ts";
export { initConfig, loadConfig, saveConfig } from "./src/config.ts";
export type { NodeConfig, UpstreamConfig } from "./src/config.ts";
export { decodeTicket, encodeTicket } from "./src/ticket.ts";
export { IrohFfiError, IrohPoisonedError, MeshUnavailableError } from "./src/errors.ts";
