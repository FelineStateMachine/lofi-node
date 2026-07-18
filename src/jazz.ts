// Thin wrapper over jazz-napi's JazzServer. Version invariant: this package
// pins the exact jazz alpha the consuming lofi app pins; wire compatibility
// across alphas is not guaranteed.

import { JazzServer } from "jazz-napi";

export interface JazzOptions {
  appId: string;
  backendSecret: string;
  adminSecret: string;
  port?: number;
  dataDir?: string;
  inMemory?: boolean;
  upstreamUrl?: string;
  allowLocalFirstAuth?: boolean;
}

export interface JazzHandle {
  url: string;
  port: number;
  stop(): Promise<void>;
}

export function allocatePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

export async function startJazz(options: JazzOptions): Promise<JazzHandle> {
  const port = options.port ?? allocatePort();
  const server = await JazzServer.start({
    appId: options.appId,
    backendSecret: options.backendSecret,
    adminSecret: options.adminSecret,
    port,
    dataDir: options.inMemory ? undefined : options.dataDir,
    inMemory: options.inMemory,
    upstreamUrl: options.upstreamUrl,
    allowLocalFirstAuth: options.allowLocalFirstAuth ?? true,
  });
  let stopped: Promise<void> | null = null;
  return {
    url: toWsUrl(server.url),
    port: server.port,
    stop: () => (stopped ??= server.stop()),
  };
}

/** JazzServer reports an http(s) URL; clients dial ws(s). */
export function toWsUrl(url: string): string {
  return url.replace(/^http/, "ws");
}
