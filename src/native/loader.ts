// Resolve the db-iroh-ffi dylib for this platform. Private prove-out order:
// explicit option → LOFI_NODE_IROH env → sibling checkout ../db-iroh-ffi →
// submodule-style native/db-iroh-ffi. Embedding prebuilts into a compiled
// binary (doorbearer's extract-to-cache pattern) comes with packaging, later.

interface Triple {
  dir: string;
  file: string;
}

const TRIPLES: Record<string, Triple> = {
  "darwin-aarch64": { dir: "aarch64-apple-darwin", file: "libdb_iroh_ffi.dylib" },
  "darwin-x86_64": { dir: "x86_64-apple-darwin", file: "libdb_iroh_ffi.dylib" },
  "linux-x86_64": { dir: "x86_64-unknown-linux-gnu", file: "libdb_iroh_ffi.so" },
  "linux-aarch64": { dir: "aarch64-unknown-linux-gnu", file: "libdb_iroh_ffi.so" },
  "windows-x86_64": { dir: "x86_64-pc-windows-gnu", file: "db_iroh_ffi.dll" },
};

export type IrohLibResolution =
  | { status: "ok"; path: string }
  | { status: "unsupported-platform"; platform: string }
  | { status: "not-found"; tried: string[] };

function exists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

export function resolveIrohLib(explicitPath?: string): IrohLibResolution {
  const platform = `${Deno.build.os}-${Deno.build.arch}`;
  const triple = TRIPLES[platform];
  if (!triple) return { status: "unsupported-platform", platform };

  const tried: string[] = [];
  const candidates = [
    explicitPath,
    Deno.env.get("LOFI_NODE_IROH"),
    `../db-iroh-ffi/target/release/${triple.file}`,
    `../db-iroh-ffi/prebuilt/${triple.dir}/${triple.file}`,
    `./native/db-iroh-ffi/prebuilt/${triple.dir}/${triple.file}`,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    tried.push(candidate);
    if (exists(candidate)) return { status: "ok", path: candidate };
  }
  return { status: "not-found", tried };
}
