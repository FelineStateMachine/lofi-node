// App-connect tickets: the credential a lofi app uses to sync against this
// node. Distinct from node-pairing tickets (src/ticket.ts — iroh
// EndpointTicket strings): an app ticket names a LOCATION (gate URL with the
// secret embedded as a path prefix) plus the app id, and optionally the
// node's iroh EndpointTicket for forward compat.
//
// The node never stores secrets — only SHA-256 digests in
// <dataDir>/tickets.json. A ticket string is printable exactly once, at
// issuance. The lofi app stores it passkey-encrypted in localStorage (see
// docs/app-ticket.md for the contract the app side implements against).

const TICKET_PREFIX = "lofisync1.";

/** 32 random bytes, base64url without padding: 43 chars, alphabet
 * [A-Za-z0-9_-] — safe as a URL path segment with no encoding. */
export const SECRET_LENGTH = 43;

export interface AppTicket {
  v: 1;
  appId: string;
  /** Gate base URL with the secret embedded: http(s)://host:port/t/<secret>.
   * Used VERBATIM as the lofi app's serverUrl — jazz clients preserve base
   * paths, so the secret rides every WS connect and catalogue fetch. */
  url: string;
  /** "sync" (default when absent — every pre-scope ticket keeps meaning
   * transport-only) or "provision": transport PLUS store administration (the
   * gate injects the node's admin secret for catalogue/admin routes).
   * Provision is a strict superset of sync. */
  scope?: "sync" | "provision";
  label?: string;
  /** The node's iroh EndpointTicket (forward compat; unused by browsers). */
  node?: string;
}

/** Persisted record of an issued ticket — digest only, never the secret. */
export interface AppTicketRecord {
  id: string;
  scope?: "sync" | "provision";
  label?: string;
  secretHash: string;
  createdAt: string;
  revokedAt?: string;
}

function base64urlNoPad(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Generate a fresh 256-bit ticket secret (43-char base64url). */
export function generateSecret(): string {
  return base64urlNoPad(crypto.getRandomValues(new Uint8Array(32)));
}

/** SHA-256 hex digest of a ticket secret — what the node stores. */
export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Serialize an app ticket to its `lofisync1.` string form. */
export function encodeAppTicket(ticket: AppTicket): string {
  return TICKET_PREFIX + base64urlNoPad(new TextEncoder().encode(JSON.stringify(ticket)));
}

/** Parse a ticket string; null on any malformed input (paste path — never
 * throws). */
export function decodeAppTicket(text: string): AppTicket | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(TICKET_PREFIX)) return null;
  try {
    const b64 = trimmed.slice(TICKET_PREFIX.length).replaceAll("-", "+").replaceAll("_", "/");
    const json = atob(b64);
    const parsed = JSON.parse(json) as AppTicket;
    if (parsed.v !== 1 || typeof parsed.appId !== "string" || typeof parsed.url !== "string") {
      return null;
    }
    if (parsed.scope !== undefined && parsed.scope !== "sync" && parsed.scope !== "provision") {
      return null;
    }
    const url = new URL(parsed.url);
    if (!/^https?:$/.test(url.protocol) || !/^\/t\/[A-Za-z0-9_-]{43}$/.test(url.pathname)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Cheap prefix check — lets the CLI `pair` command reject app tickets with a
 * pointed message (an app ticket is not a node-pairing ticket). */
export function looksLikeAppTicket(text: string): boolean {
  return text.trim().startsWith(TICKET_PREFIX);
}

interface TicketsFile {
  v: 1;
  tickets: AppTicketRecord[];
}

function timingSafeEqualHex(a: string, b: string): boolean {
  // Constant-time over same-length hex digests; length mismatch exits early,
  // which leaks only that the input wasn't a SHA-256 hex string.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type VerifyResult =
  | { status: "valid"; record: AppTicketRecord }
  | { status: "revoked"; record: AppTicketRecord }
  | { status: "unknown" };

/** Issued-ticket persistence. File-backed when a dataDir is given (the CLI
 * writes it; a running daemon only READS, picking up changes via mtime — so
 * `ticket issue`/`revoke` need no IPC), in-memory otherwise (tests, ephemeral
 * nodes). */
export class AppTicketStore {
  #path: string | null;
  #tickets: AppTicketRecord[] = [];
  #mtime = 0;
  #lastStat = 0;

  private constructor(path: string | null) {
    this.#path = path;
  }

  static async load(dataDir?: string): Promise<AppTicketStore> {
    const store = new AppTicketStore(dataDir ? `${dataDir}/tickets.json` : null);
    await store.#reload();
    return store;
  }

  async #reload(): Promise<void> {
    if (!this.#path) return;
    try {
      const stat = await Deno.stat(this.#path);
      const mtime = stat.mtime?.getTime() ?? 0;
      if (mtime !== 0 && mtime === this.#mtime) return;
      const parsed = JSON.parse(await Deno.readTextFile(this.#path)) as TicketsFile;
      if (parsed.v !== 1) throw new Error(`unsupported tickets.json version ${parsed.v}`);
      this.#tickets = parsed.tickets;
      this.#mtime = mtime;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        this.#tickets = [];
        this.#mtime = 0;
        return;
      }
      throw e;
    }
  }

  /** Throttled (~1s) mtime check so per-request verify stays cheap. */
  async #maybeReload(): Promise<void> {
    const now = Date.now();
    if (now - this.#lastStat < 1000) return;
    this.#lastStat = now;
    await this.#reload();
  }

  async #persist(): Promise<void> {
    if (!this.#path) return;
    const file: TicketsFile = { v: 1, tickets: this.#tickets };
    const tmp = `${this.#path}.${Deno.pid}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(file, null, 2) + "\n");
    await Deno.rename(tmp, this.#path);
    this.#mtime = (await Deno.stat(this.#path)).mtime?.getTime() ?? 0;
  }

  async issue(
    label?: string,
    scope: "sync" | "provision" = "sync",
  ): Promise<{ record: AppTicketRecord; secret: string }> {
    await this.#reload();
    const secret = generateSecret();
    const secretHash = await hashSecret(secret);
    const record: AppTicketRecord = {
      id: secretHash.slice(0, 12),
      scope,
      label,
      secretHash,
      createdAt: new Date().toISOString(),
    };
    this.#tickets.push(record);
    await this.#persist();
    return { record, secret };
  }

  async revoke(id: string): Promise<AppTicketRecord | null> {
    await this.#reload();
    const record = this.#tickets.find((t) => t.id === id);
    if (!record) return null;
    if (!record.revokedAt) {
      record.revokedAt = new Date().toISOString();
      await this.#persist();
    }
    return record;
  }

  async list(): Promise<AppTicketRecord[]> {
    await this.#reload();
    return [...this.#tickets];
  }

  /** Timing-safe lookup by presented secret. Compares against EVERY record
   * (valid and revoked) so probers cannot distinguish unknown from revoked by
   * timing; the gate returns 401 for both. */
  async verify(secret: string): Promise<VerifyResult> {
    await this.#maybeReload();
    const presented = await hashSecret(secret);
    let match: AppTicketRecord | null = null;
    for (const record of this.#tickets) {
      if (timingSafeEqualHex(presented, record.secretHash)) match = record;
    }
    if (!match) return { status: "unknown" };
    return match.revokedAt
      ? { status: "revoked", record: match }
      : { status: "valid", record: match };
  }
}
