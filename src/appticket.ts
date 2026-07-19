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

/** A device public key bound to a ticket at derive time: connections on the
 * ticket then require a proof-of-possession challenge, so the ticket string
 * alone no longer connects. `alg` is carried per record so a future curve
 * upgrade is a value change, not a format change. */
export interface AppTicketPop {
  alg: "ES256";
  /** base64url DER SubjectPublicKeyInfo of the device's P-256 public key. */
  spki: string;
  boundAt: string;
}

/** Persisted record of an issued ticket — digest only, never the secret. */
export interface AppTicketRecord {
  id: string;
  scope?: "sync" | "provision";
  label?: string;
  /** Id of the ticket this one was derived from (the gate's scope-down
   * exchange). Revocation cascades: a ticket is dead whenever any ancestor
   * is revoked or missing. */
  parentId?: string;
  secretHash: string;
  createdAt: string;
  revokedAt?: string;
  /** Present when the ticket is possession-bound; absent records stay pure
   * bearer, so tickets.json remains v1 and older nodes ignore the field. */
  pop?: AppTicketPop;
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

/** True when the record or any ancestor in `all` is revoked or missing —
 * derived tickets die with their parent, so the check walks the whole chain
 * (bounded; a cycle would mean a corrupt file and counts as dead). */
export function isRevokedByLineage(record: AppTicketRecord, all: AppTicketRecord[]): boolean {
  const seen = new Set<string>();
  let cursor: AppTicketRecord | undefined = record;
  while (cursor) {
    if (cursor.revokedAt) return true;
    if (cursor.parentId === undefined) return false;
    if (seen.has(cursor.id)) return true;
    seen.add(cursor.id);
    const parentId: string = cursor.parentId;
    cursor = all.find((t) => t.id === parentId);
  }
  return true; // parent record missing
}

export type VerifyResult =
  | { status: "valid"; record: AppTicketRecord }
  | { status: "revoked"; record: AppTicketRecord }
  | { status: "unknown" };

/** Issued-ticket persistence. File-backed when a dataDir is given (the CLI
 * writes it for issue/revoke; the daemon reads via throttled mtime checks —
 * so those commands need no IPC — and writes only when the gate's scope-down
 * exchange derives a ticket), in-memory otherwise (tests, ephemeral nodes). */
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

  /** Issue a ticket. `parentId` links a derived ticket to the ticket it was
   * minted from — the derived ticket then dies with its parent. The parent
   * must be live at issuance. `pop` binds a device public key: the gate then
   * requires a proof-of-possession exchange before any connection on the
   * ticket. Records without a parent or pop serialize exactly as before (the
   * fields are omitted), so tickets.json stays v1. */
  async issue(
    label?: string,
    scope: "sync" | "provision" = "sync",
    parentId?: string,
    pop?: Omit<AppTicketPop, "boundAt">,
  ): Promise<{ record: AppTicketRecord; secret: string }> {
    await this.#reload();
    if (parentId !== undefined) {
      const parent = this.#tickets.find((t) => t.id === parentId);
      if (!parent || isRevokedByLineage(parent, this.#tickets)) {
        throw new Error(`parent ticket ${parentId} is unknown or revoked`);
      }
    }
    const secret = generateSecret();
    const secretHash = await hashSecret(secret);
    const record: AppTicketRecord = {
      id: secretHash.slice(0, 12),
      scope,
      label,
      parentId,
      secretHash,
      createdAt: new Date().toISOString(),
      ...(pop ? { pop: { ...pop, boundAt: new Date().toISOString() } } : {}),
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
   * timing; the gate returns 401 for both. A derived ticket whose lineage is
   * dead reports "revoked" exactly like a directly revoked one. */
  async verify(secret: string): Promise<VerifyResult> {
    await this.#maybeReload();
    const presented = await hashSecret(secret);
    let match: AppTicketRecord | null = null;
    for (const record of this.#tickets) {
      if (timingSafeEqualHex(presented, record.secretHash)) match = record;
    }
    if (!match) return { status: "unknown" };
    return isRevokedByLineage(match, this.#tickets)
      ? { status: "revoked", record: match }
      : { status: "valid", record: match };
  }
}

/** The exact bytes a device signs to prove possession: version line, app id,
 * ticket id, and the challenge nonce, newline-joined. Binding the app and
 * ticket ids prevents splicing a signature across stores or tickets; the
 * single-use nonce prevents replay. */
export function popMessage(appId: string, ticketId: string, nonce: string): Uint8Array {
  return new TextEncoder().encode(`lofisync-pop-v1\n${appId}\n${ticketId}\n${nonce}`);
}

function fromBase64url(text: string): Uint8Array {
  const b64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Import a bound device key's SPKI; throws on any malformed or wrong-curve
 * key — used by the derive endpoint to reject bad bindings up front. */
export async function importPopKey(spki: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "spki",
    fromBase64url(spki).buffer as ArrayBuffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

/** Verify a proof-of-possession signature (WebCrypto raw r||s ECDSA over
 * SHA-256). False on any failure — malformed keys and signatures verify
 * false rather than throwing, so the caller keeps one rejection path. */
export async function verifyPopSignature(
  spki: string,
  message: Uint8Array,
  signature: string,
): Promise<boolean> {
  try {
    const key = await importPopKey(spki);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64url(signature).buffer as ArrayBuffer,
      message.buffer as ArrayBuffer,
    );
  } catch {
    return false;
  }
}
