// dataDir layout: config.json (app id, secrets, upstream election) and
// iroh.key (32-byte node secret, hex, 0600). Secrets are generated on init
// and persisted — the node's identity and its Jazz credentials both survive
// restarts, so tickets and client sessions stay stable.

export type UpstreamConfig = "none" | { url: string } | { peer: string };

export interface NodeConfig {
  v: 1;
  appId: string;
  backendSecret: string;
  adminSecret: string;
  listenPort?: number;
  upstream: UpstreamConfig;
  allowLocalFirstAuth: boolean;
}

function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_")
    .replaceAll("=", "");
  return `${prefix}_${b64}`;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(text: string): Uint8Array {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function configPath(dataDir: string): string {
  return `${dataDir}/config.json`;
}

export async function loadConfig(dataDir: string): Promise<NodeConfig | null> {
  try {
    const raw = await Deno.readTextFile(configPath(dataDir));
    const parsed = JSON.parse(raw) as NodeConfig;
    if (parsed.v !== 1) throw new Error(`unsupported config version ${parsed.v}`);
    return parsed;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

export async function saveConfig(dataDir: string, config: NodeConfig): Promise<void> {
  await Deno.mkdir(dataDir, { recursive: true });
  await Deno.writeTextFile(configPath(dataDir), JSON.stringify(config, null, 2) + "\n");
}

export async function initConfig(
  dataDir: string,
  overrides: Partial<Pick<NodeConfig, "appId" | "listenPort" | "upstream">> = {},
): Promise<NodeConfig> {
  const existing = await loadConfig(dataDir);
  if (existing) return existing;
  const config: NodeConfig = {
    v: 1,
    appId: overrides.appId ?? crypto.randomUUID(),
    backendSecret: randomToken("lofi_backend"),
    adminSecret: randomToken("lofi_admin"),
    listenPort: overrides.listenPort,
    upstream: overrides.upstream ?? "none",
    allowLocalFirstAuth: true,
  };
  await saveConfig(dataDir, config);
  return config;
}

/** Load-or-create the node's 32-byte iroh secret key. */
export async function loadOrCreateIrohKey(dataDir: string): Promise<Uint8Array> {
  const path = `${dataDir}/iroh.key`;
  try {
    const hex = (await Deno.readTextFile(path)).trim();
    if (hex.length === 64) return fromHex(hex);
    throw new Error(`corrupt iroh.key at ${path}`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const key = crypto.getRandomValues(new Uint8Array(32));
  await Deno.mkdir(dataDir, { recursive: true });
  await Deno.writeTextFile(path, toHex(key) + "\n", { mode: 0o600 });
  return key;
}
