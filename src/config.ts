// dataDir layout: config.json (app id, secrets, upstream election) and
// iroh.key (32-byte node secret, hex, 0600). Secrets are generated on init
// and persisted — the node's identity and its Jazz credentials both survive
// restarts, so tickets and client sessions stay stable.

export type UpstreamConfig = "none" | { url: string } | { peer: string };

/** Where node data lives. jazz-napi supports exactly these two today; the
 * `type` discriminator is the seam future providers slot into. `path` may be
 * any mounted location (NAS, synced volume) — validated writable at boot. */
export type StorageConfig = { type: "sqlite"; path?: string } | { type: "memory" };

export interface NodeConfig {
  v: 2;
  appId: string;
  backendSecret: string;
  adminSecret: string;
  listenPort?: number;
  /** "ticket": only issued app tickets reach Jazz (CLI init default).
   * "open": today's behavior (library/test default). */
  access: "open" | "ticket";
  storage: StorageConfig;
  /** Base URL embedded into issued tickets, e.g. "http://192.168.1.10:4802". */
  publicUrl?: string;
  upstream: UpstreamConfig;
  allowLocalFirstAuth: boolean;
}

const SUPPORTED_STORAGE = ["sqlite", "memory"];

export function validateStorage(storage: StorageConfig): void {
  if (!SUPPORTED_STORAGE.includes(storage.type)) {
    throw new Error(
      `unsupported storage type "${(storage as { type: string }).type}" — jazz-napi supports ` +
        `${
          SUPPORTED_STORAGE.join(" | ")
        } today; see docs/hosting-lofi-apps.md for provider recipes`,
    );
  }
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
    const parsed = JSON.parse(raw) as { v: number } & Partial<Omit<NodeConfig, "v">>;
    if (parsed.v === 1) {
      // Lazy v1→v2 migration: existing dirs keep exact current behavior.
      // Persisted as v2 on the next explicit saveConfig.
      return {
        ...(parsed as unknown as NodeConfig),
        v: 2,
        access: parsed.access ?? "open",
        storage: parsed.storage ?? { type: "sqlite" },
      };
    }
    if (parsed.v !== 2) {
      throw new Error(
        `unsupported config version ${parsed.v} — this lofi-node reads v1 and v2 config.json`,
      );
    }
    const config = parsed as NodeConfig;
    validateStorage(config.storage);
    return config;
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
  overrides: Partial<
    Pick<NodeConfig, "appId" | "listenPort" | "upstream" | "access" | "storage" | "publicUrl">
  > = {},
): Promise<NodeConfig> {
  const existing = await loadConfig(dataDir);
  if (existing) return existing;
  const config: NodeConfig = {
    v: 2,
    appId: overrides.appId ?? crypto.randomUUID(),
    backendSecret: randomToken("lofi_backend"),
    adminSecret: randomToken("lofi_admin"),
    listenPort: overrides.listenPort,
    // Secure by default for real installs; the library default stays "open".
    access: overrides.access ?? "ticket",
    storage: overrides.storage ?? { type: "sqlite" },
    publicUrl: overrides.publicUrl,
    upstream: overrides.upstream ?? "none",
    allowLocalFirstAuth: true,
  };
  validateStorage(config.storage);
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
