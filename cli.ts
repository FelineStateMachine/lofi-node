// lofi-node CLI — init / start / pair / status. Prove-out scope: `pair`
// persists the election and asks for a restart (no daemon IPC yet).

import { initConfig, loadConfig, saveConfig } from "./src/config.ts";
import { createSyncNode } from "./src/node.ts";
import { decodeTicket } from "./src/ticket.ts";

const USAGE = `lofi-node — self-hostable Jazz sync node with iroh transport

Usage:
  lofi-node init   [--dir <dataDir>] [--app-id <id>] [--port <n>]
  lofi-node start  [--dir <dataDir>]
  lofi-node pair   <ticket> [--dir <dataDir>]
  lofi-node status [--dir <dataDir>]

The data directory defaults to ./lofi-node-data.`;

interface Args {
  command: string;
  positional: string[];
  dir: string;
  appId?: string;
  port?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? "", positional: [], dir: "./lofi-node-data" };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") args.dir = argv[++i];
    else if (arg === "--app-id") args.appId = argv[++i];
    else if (arg === "--port") args.port = Number(argv[++i]);
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

async function cmdInit(args: Args) {
  const existing = await loadConfig(args.dir);
  if (existing) fail(`already initialized: ${args.dir}/config.json`);
  const config = await initConfig(args.dir, { appId: args.appId, listenPort: args.port });
  console.log(`initialized ${args.dir}`);
  console.log(`  app id:     ${config.appId}`);
  console.log(`  listen:     ${config.listenPort ?? "(auto)"}`);
  console.log(`\nNext: lofi-node start --dir ${args.dir}`);
}

async function cmdStart(args: Args) {
  const config = await requireConfig(args.dir);
  const node = await createSyncNode({
    appId: config.appId,
    backendSecret: config.backendSecret,
    adminSecret: config.adminSecret,
    dataDir: args.dir,
    listen: config.listenPort ? { port: config.listenPort } : undefined,
    upstream: config.upstream,
    allowLocalFirstAuth: config.allowLocalFirstAuth,
  });
  const status = node.status();
  console.log(`lofi-node up`);
  console.log(`  app id:     ${node.appId}`);
  console.log(`  jazz url:   ${node.url}   <- point JAZZ_SERVER_URL here`);
  console.log(`  storage:    ${status.jazz.storage} (${args.dir})`);
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
    // Parked db_accept threads cannot be woken (upstream gap); exit hard.
    Deno.exit(0);
  });
  await new Promise(() => {});
}

async function cmdPair(args: Args) {
  const ticket = args.positional[0];
  if (!ticket) fail("usage: lofi-node pair <ticket>");
  if (!decodeTicket(ticket)) fail("malformed ticket (expected LFN1.…)");
  const config = await requireConfig(args.dir);
  config.upstream = { peer: ticket };
  await saveConfig(args.dir, config);
  console.log("pairing saved. Restart the node to apply: lofi-node start");
}

async function cmdStatus(args: Args) {
  const config = await requireConfig(args.dir);
  console.log(`  app id:     ${config.appId}`);
  console.log(`  listen:     ${config.listenPort ?? "(auto)"}`);
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
  case "status":
    await cmdStatus(args);
    break;
  default:
    console.log(USAGE);
    Deno.exit(args.command ? 1 : 0);
}
