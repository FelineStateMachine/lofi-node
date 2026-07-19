/**
 * The lofi-node CLI: `init`, `start`, `pair`, `ticket issue|list|revoke`,
 * `status`.
 *
 * Run it straight from JSR:
 *
 * ```sh
 * dx -A jsr:@nzip/lofi-node/cli init --port 4802
 * dx -A jsr:@nzip/lofi-node/cli start
 * ```
 *
 * Ticket verbs write `<dataDir>/tickets.json` directly; a RUNNING daemon
 * picks changes up via the ticket store's mtime hot-reload, so issue/revoke
 * take effect without a restart and without IPC.
 *
 * @module
 */

import {
  initConfig,
  loadConfig,
  type RelayConfig,
  saveConfig,
  type StorageConfig,
  validateRelay,
} from "./src/config.ts";
import { createSyncNode } from "./src/node.ts";
import { looksLikeTicket } from "./src/ticket.ts";
import {
  AppTicketStore,
  encodeAppTicket,
  isRevokedByLineage,
  looksLikeAppTicket,
} from "./src/appticket.ts";
import { readTicketActivity } from "./src/ticket-activity.ts";

const USAGE = `lofi-node — self-hostable sync node for lofi apps

Usage:
  lofi-node init   [--dir <dataDir>] [--app-id <id>] [--port <n>]
                   [--public-url <base>] [--open] [--storage-path <path>] [--memory]
                   [--relay <url[,url…]>] [--no-relay]
  lofi-node start  [--dir <dataDir>]
  lofi-node pair   <node-ticket> [--dir <dataDir>]
  lofi-node ticket issue  [--label <s>] [--url <base>] [--provision] [--dir <dataDir>]
  lofi-node ticket list   [--dir <dataDir>]
  lofi-node ticket revoke <id> [--dir <dataDir>]
  lofi-node status [--dir <dataDir>]

The data directory defaults to ./lofi-node-data. New inits are ticket-gated
(--open opts out); app tickets are issued with \`ticket issue\` and pasted
into the lofi app.

Relays default to n0's public servers — rate-limited, fine for development.
For production point --relay at your own iroh-relay (comma-separated for
more than one), or pass --no-relay for direct connections only.`;

interface Args {
  command: string;
  positional: string[];
  dir: string;
  appId?: string;
  port?: number;
  publicUrl?: string;
  label?: string;
  url?: string;
  open: boolean;
  memory: boolean;
  provision: boolean;
  storagePath?: string;
  relayUrls: string[];
  noRelay: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: argv[0] ?? "",
    positional: [],
    dir: "./lofi-node-data",
    open: false,
    memory: false,
    provision: false,
    relayUrls: [],
    noRelay: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") args.dir = argv[++i];
    else if (arg === "--app-id") args.appId = argv[++i];
    else if (arg === "--port") args.port = Number(argv[++i]);
    else if (arg === "--public-url") args.publicUrl = argv[++i];
    else if (arg === "--label") args.label = argv[++i];
    else if (arg === "--url") args.url = argv[++i];
    else if (arg === "--open") args.open = true;
    else if (arg === "--memory") args.memory = true;
    else if (arg === "--provision") args.provision = true;
    else if (arg === "--storage-path") args.storagePath = argv[++i];
    else if (arg === "--relay") {
      args.relayUrls.push(...(argv[++i] ?? "").split(",").map((u) => u.trim()).filter(Boolean));
    } else if (arg === "--no-relay") args.noRelay = true;
    else args.positional.push(arg);
  }
  return args;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  Deno.exit(1);
}

async function requireConfig(dir: string) {
  const config = await loadConfig(dir);
  if (!config) fail(`no config at ${dir}/config.json — run: lofi-node init --dir ${dir}`);
  return config;
}

function describeStorage(storage: StorageConfig, dir: string): string {
  if (storage.type === "memory") return "memory (no persistence)";
  return `sqlite (${storage.path ?? `${dir}/jazz`})`;
}

function describeRelay(relay: RelayConfig | undefined): string {
  if (relay === undefined || relay === "n0") return "n0 public relays (dev default)";
  if (relay === "disabled") return "disabled (direct connections only)";
  return `custom (${relay.urls.join(", ")})`;
}

function lanAddress(): string | null {
  try {
    for (const iface of Deno.networkInterfaces()) {
      if (iface.family === "IPv4" && !iface.address.startsWith("127.")) return iface.address;
    }
  } catch {
    // permission or platform issue — fall through
  }
  return null;
}

async function cmdInit(args: Args) {
  const existing = await loadConfig(args.dir);
  if (existing) fail(`already initialized: ${args.dir}/config.json`);
  const storage: StorageConfig = args.memory
    ? { type: "memory" }
    : { type: "sqlite", path: args.storagePath };
  if (args.noRelay && args.relayUrls.length > 0) {
    fail("--no-relay and --relay are mutually exclusive");
  }
  const relay: RelayConfig | undefined = args.noRelay
    ? "disabled"
    : args.relayUrls.length > 0
    ? { urls: args.relayUrls }
    : undefined;
  if (relay) {
    try {
      validateRelay(relay);
    } catch (e) {
      fail((e as Error).message);
    }
  }
  const config = await initConfig(args.dir, {
    appId: args.appId,
    listenPort: args.port,
    access: args.open ? "open" : "ticket",
    storage,
    publicUrl: args.publicUrl,
    relay,
  });
  console.log(`initialized ${args.dir}`);
  console.log(`  app id:     ${config.appId}`);
  console.log(`  access:     ${config.access}`);
  console.log(`  storage:    ${describeStorage(config.storage, args.dir)}`);
  console.log(`  relay:      ${describeRelay(config.relay)}`);
  console.log(`  listen:     ${config.listenPort ?? "(auto)"}`);
  if (config.access === "ticket") {
    console.log(`\nNext: lofi-node start --dir ${args.dir}`);
    console.log(`Then: lofi-node ticket issue --dir ${args.dir}   # connect an app`);
  } else {
    console.log(`\nNext: lofi-node start --dir ${args.dir}`);
  }
}

async function cmdStart(args: Args) {
  const config = await requireConfig(args.dir);
  const node = await createSyncNode({
    appId: config.appId,
    backendSecret: config.backendSecret,
    adminSecret: config.adminSecret,
    dataDir: args.dir,
    listen: config.listenPort ? { port: config.listenPort } : undefined,
    access: config.access,
    storage: config.storage,
    publicUrl: config.publicUrl,
    upstream: config.upstream,
    relay: config.relay,
    allowLocalFirstAuth: config.allowLocalFirstAuth,
  });
  const status = node.status();
  console.log(`lofi-node up`);
  console.log(`  app id:     ${node.appId}`);
  console.log(`  access:     ${status.access}`);
  if (status.access === "ticket") {
    console.log(`  gate:       ${node.url}   (apps connect with an issued ticket URL)`);
    console.log(
      `  tickets:    ${
        status.tickets.filter((t) => !t.revoked).length
      } active — issue with: lofi-node ticket issue --dir ${args.dir}`,
    );
  } else {
    console.log(`  jazz url:   ${node.url}   <- point JAZZ_SERVER_URL here`);
  }
  console.log(`  storage:    ${describeStorage(status.jazz.storage, args.dir)}`);
  console.log(
    `  upstream:   ${
      status.upstream === "none"
        ? "none"
        : "url" in status.upstream
        ? status.upstream.url
        : "peer (over iroh)"
    }`,
  );
  if (status.mesh.state === "up") {
    console.log(`  mesh:       up (node ${status.mesh.nodeId.slice(0, 16)}…)`);
    console.log(`  relay:      ${describeRelay(config.relay)}`);
    console.log(`  ticket:     ${status.mesh.ticket}`);
  } else if (status.mesh.state === "unavailable") {
    console.log(`  mesh:       UNAVAILABLE — ${status.mesh.reason}`);
    console.log(`              (LAN-only Jazz server; pairing disabled)`);
  }
  console.log(`\nCtrl-C to stop.`);
  Deno.addSignalListener("SIGINT", async () => {
    console.log("\nstopping…");
    try {
      await node.stop();
    } catch (e) {
      console.error(`shutdown error: ${(e as Error).message}`);
    }
    Deno.exit(0);
  });
  await new Promise(() => {});
}

async function cmdPair(args: Args) {
  const ticket = args.positional[0];
  if (!ticket) fail("usage: lofi-node pair <node-ticket>");
  if (looksLikeAppTicket(ticket)) {
    fail(
      "that is an app-connect ticket (lofisync1.…); pairing takes a NODE ticket " +
        "(the endpoint… string printed by lofi-node start on the other node)",
    );
  }
  if (!looksLikeTicket(ticket)) fail("that does not look like a node-pairing ticket");
  const config = await requireConfig(args.dir);
  config.upstream = { peer: ticket };
  await saveConfig(args.dir, config);
  console.log("pairing saved. Restart the node to apply: lofi-node start");
}

async function cmdTicket(args: Args) {
  const sub = args.positional[0];
  const config = await requireConfig(args.dir);
  if (config.access !== "ticket") {
    fail(`node access is "${config.access}" — app tickets require access: "ticket"`);
  }
  const store = await AppTicketStore.load(args.dir);

  if (sub === "issue") {
    if (!config.listenPort && !args.url && !config.publicUrl) {
      fail(
        "ticket URLs need a stable address: set a fixed port (init --port) plus " +
          "--public-url/--url, or pass --url explicitly",
      );
    }
    let base = args.url ?? config.publicUrl;
    if (!base) {
      const lan = lanAddress();
      base = `http://${lan ?? "127.0.0.1"}:${config.listenPort}`;
      if (lan) {
        console.error(
          `note: auto-detected LAN address ${lan} — pin with --public-url if this is wrong`,
        );
      }
    }
    const scope = args.provision ? "provision" as const : "sync" as const;
    const { record, secret } = await store.issue(args.label, scope);
    const ticket = encodeAppTicket({
      v: 1,
      appId: config.appId,
      url: `${base.replace(/\/+$/, "")}/t/${secret}`,
      scope: scope === "provision" ? "provision" : undefined,
      label: args.label,
    });
    console.log(
      `issued ${scope} ticket ${record.id}${args.label ? ` (${args.label})` : ""}`,
    );
    console.log(`\n${ticket}\n`);
    console.log("Paste this into the lofi app. The secret is NOT stored and cannot");
    console.log("be shown again; a running node accepts it immediately.");
    if (scope === "provision") {
      console.log("PROVISION scope: this ticket also unlocks store administration");
      console.log("(schema deploys) through the gate. Issue per provisioning context.");
    }
    return;
  }

  if (sub === "list") {
    const tickets = await store.list();
    if (tickets.length === 0) {
      console.log("no tickets issued");
      return;
    }
    // Last-seen comes from the daemon-owned sidecar; absent (never seen, or
    // the node has not flushed yet) prints as "-".
    const activity = args.dir ? await readTicketActivity(args.dir) : new Map<string, string>();
    for (const t of tickets) {
      // Lineage-aware: a derived ticket shows REVOKED once its parent is.
      const dead = isRevokedByLineage(t, tickets);
      const lastSeen = activity.get(t.id) ?? "-";
      console.log(
        `${t.id}  ${dead ? "REVOKED" : "active "}  ${
          (t.scope ?? "sync").padEnd(9)
        }  ${t.createdAt}  seen ${lastSeen}  ${t.label ?? ""}${
          t.parentId ? `  [from ${t.parentId}]` : ""
        }`,
      );
    }
    return;
  }

  if (sub === "revoke") {
    const id = args.positional[1];
    if (!id) fail("usage: lofi-node ticket revoke <id>");
    const record = await store.revoke(id);
    if (!record) fail(`no ticket with id ${id} (see: lofi-node ticket list)`);
    console.log(`revoked ${id} — takes effect immediately if the node is running`);
    return;
  }

  fail("usage: lofi-node ticket <issue|list|revoke>");
}

async function cmdStatus(args: Args) {
  const config = await requireConfig(args.dir);
  const store = await AppTicketStore.load(args.dir);
  const tickets = await store.list();
  console.log(`  app id:     ${config.appId}`);
  console.log(`  access:     ${config.access}`);
  console.log(`  storage:    ${describeStorage(config.storage, args.dir)}`);
  console.log(`  relay:      ${describeRelay(config.relay)}`);
  console.log(`  listen:     ${config.listenPort ?? "(auto)"}`);
  console.log(
    `  tickets:    ${tickets.filter((t) => !t.revokedAt).length} active / ${tickets.length} issued`,
  );
  console.log(
    `  upstream:   ${
      config.upstream === "none"
        ? "none"
        : "url" in config.upstream
        ? config.upstream.url
        : "peer (over iroh)"
    }`,
  );
  if (config.listenPort) {
    try {
      const res = await fetch(`http://127.0.0.1:${config.listenPort}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      console.log(`  daemon:     ${res.status === 200 ? "running" : `unhealthy (${res.status})`}`);
    } catch {
      console.log(`  daemon:     not running`);
    }
  }
}

const args = parseArgs(Deno.args);
switch (args.command) {
  case "init":
    await cmdInit(args);
    break;
  case "start":
    await cmdStart(args);
    break;
  case "pair":
    await cmdPair(args);
    break;
  case "ticket":
    await cmdTicket(args);
    break;
  case "status":
    await cmdStatus(args);
    break;
  default:
    console.log(USAGE);
    Deno.exit(args.command ? 1 : 0);
}
