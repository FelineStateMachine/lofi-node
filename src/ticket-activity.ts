// Last-seen activity per ticket, persisted in a daemon-owned sidecar so the
// CLI can answer "is that phone still using this ticket?" without IPC. A
// separate file — never tickets.json — because tickets.json is CLI-written
// and mtime-hot-reloaded by the daemon: a second writer would race the CLI's
// read-modify-write and thrash the reload throttle. Writes are throttled and
// dirty-only; last-seen is operational telemetry where minute granularity is
// plenty.

interface ActivityFile {
  v: 1;
  seen: Record<string, string>;
}

const FLUSH_INTERVAL_MS = 60_000;

/** Daemon-owned last-seen tracking; file-backed when a dataDir is given. */
export class TicketActivity {
  #path: string | null;
  #seen = new Map<string, string>();
  #dirty = false;
  #lastFlush = 0;
  #inFlight: Promise<void> = Promise.resolve();

  private constructor(path: string | null) {
    this.#path = path;
  }

  static async load(dataDir?: string): Promise<TicketActivity> {
    const activity = new TicketActivity(dataDir ? `${dataDir}/ticket-activity.json` : null);
    if (activity.#path) {
      try {
        const parsed = JSON.parse(await Deno.readTextFile(activity.#path)) as ActivityFile;
        if (parsed.v === 1) {
          for (const [id, at] of Object.entries(parsed.seen)) activity.#seen.set(id, at);
        }
      } catch {
        // Missing or unreadable sidecar: telemetry starts fresh.
      }
    }
    return activity;
  }

  /** Record activity on a ticket now; flushes at most once per interval. */
  note(ticketId: string): void {
    this.#seen.set(ticketId, new Date().toISOString());
    this.#dirty = true;
    if (Date.now() - this.#lastFlush >= FLUSH_INTERVAL_MS) {
      this.flush().catch(() => {});
    }
  }

  /** The last recorded activity for a ticket, if any. */
  lastSeen(ticketId: string): string | undefined {
    return this.#seen.get(ticketId);
  }

  /** Write the sidecar when dirty; called on interval hits and shutdown.
   * Writes are serialized, and a flush resolves only after every write
   * scheduled before it has landed. */
  flush(): Promise<void> {
    this.#inFlight = this.#inFlight.then(() => this.#write());
    return this.#inFlight;
  }

  async #write(): Promise<void> {
    if (!this.#dirty || !this.#path) return;
    this.#dirty = false;
    this.#lastFlush = Date.now();
    const file: ActivityFile = { v: 1, seen: Object.fromEntries(this.#seen) };
    const tmp = `${this.#path}.${Deno.pid}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(file, null, 2) + "\n");
    await Deno.rename(tmp, this.#path);
  }
}

/** Read-only sidecar view for the CLI (a separate process from the daemon). */
export async function readTicketActivity(dataDir: string): Promise<Map<string, string>> {
  try {
    const parsed = JSON.parse(
      await Deno.readTextFile(`${dataDir}/ticket-activity.json`),
    ) as ActivityFile;
    if (parsed.v !== 1) return new Map();
    return new Map(Object.entries(parsed.seen));
  } catch {
    return new Map();
  }
}
