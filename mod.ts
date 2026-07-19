/**
 * Self-hostable sync node for lofi apps: one daemon embedding a Jazz 2.0
 * sync server, iroh node-to-node transport, and a ticket-gated access layer.
 *
 * Create a node, issue an app-connect ticket, and point a lofi app's
 * `JAZZ_SERVER_URL` at the ticket URL:
 *
 * ```ts
 * import { createSyncNode } from "@nzip/lofi-node";
 *
 * const node = await createSyncNode({
 *   appId: crypto.randomUUID(),
 *   backendSecret: "...",
 *   adminSecret: "...",
 *   dataDir: "./data",
 *   access: "ticket",
 * });
 * const { ticket } = await node.issueTicket({ label: "phone" });
 * // the app seals `ticket` at rest and uses its URL as serverUrl
 * ```
 *
 * The CLI lives at the `./cli` export (`dx -A jsr:@nzip/lofi-node/cli`), and
 * in-process test helpers at `./testing`.
 *
 * @module
 */

export { createSyncNode } from "./src/node.ts";
export type {
  AppTicketInfo,
  MeshStatus,
  SyncNode,
  SyncNodeOptions,
  SyncNodeStatus,
} from "./src/node.ts";
export {
  initConfig,
  loadConfig,
  saveConfig,
  validateRelay,
  validateStorage,
} from "./src/config.ts";
export type { NodeConfig, RelayConfig, StorageConfig, UpstreamConfig } from "./src/config.ts";
export { looksLikeTicket } from "./src/ticket.ts";
export { decodeAppTicket, encodeAppTicket, looksLikeAppTicket } from "./src/appticket.ts";
export type { AppTicket } from "./src/appticket.ts";
export { CLOSE_TICKET_REVOKED } from "./src/gate.ts";
export { MeshUnavailableError } from "./src/errors.ts";
export {
  classifyMutationError,
  isPermanentMutationError,
  MUTATION_ERROR_CLASSES,
} from "./src/verdict.ts";
export type { MutationErrorClass } from "./src/verdict.ts";
