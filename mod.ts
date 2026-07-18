// @nzip/lofi-node — self-hostable Jazz sync node with iroh node-to-node
// transport. Private prove-out; see README for status and roadmap.

export { createSyncNode } from "./src/node.ts";
export type {
  AppTicketInfo,
  MeshStatus,
  SyncNode,
  SyncNodeOptions,
  SyncNodeStatus,
} from "./src/node.ts";
export { initConfig, loadConfig, saveConfig, validateStorage } from "./src/config.ts";
export type { NodeConfig, StorageConfig, UpstreamConfig } from "./src/config.ts";
export { looksLikeTicket } from "./src/ticket.ts";
export { decodeAppTicket, encodeAppTicket, looksLikeAppTicket } from "./src/appticket.ts";
export type { AppTicket } from "./src/appticket.ts";
export { CLOSE_TICKET_REVOKED } from "./src/gate.ts";
export { MeshUnavailableError } from "./src/errors.ts";
