// Resolve the vendored iroh-js napi addon for this platform. Resolution
// order: explicit option → LOFI_NODE_IROH env → in-repo cargo build output →
// prebuilt/<triple>. Embedding artifacts into a compiled binary comes with
// packaging, later.

interface Triple {
  dir: string;
  cargoFile: string;
}

const TRIPLES: Record<string, Triple> = {
  "darwin-aarch64": { dir: "aarch64-apple-darwin", cargoFile: "libnumber0_iroh.dylib" },
  "darwin-x86_64": { dir: "x86_64-apple-darwin", cargoFile: "libnumber0_iroh.dylib" },
  "linux-x86_64": { dir: "x86_64-unknown-linux-gnu", cargoFile: "libnumber0_iroh.so" },
  "linux-aarch64": { dir: "aarch64-unknown-linux-gnu", cargoFile: "libnumber0_iroh.so" },
  "windows-x86_64": { dir: "x86_64-pc-windows-gnu", cargoFile: "number0_iroh.dll" },
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

const HERE = new URL(".", import.meta.url).pathname;

export function resolveIrohLib(explicitPath?: string): IrohLibResolution {
  const platform = `${Deno.build.os}-${Deno.build.arch}`;
  const triple = TRIPLES[platform];
  if (!triple) return { status: "unsupported-platform", platform };

  const tried: string[] = [];
  const candidates = [
    explicitPath,
    Deno.env.get("LOFI_NODE_IROH"),
    `${HERE}../../native/iroh-js/target/release/${triple.cargoFile}`,
    `./native/iroh-js/target/release/${triple.cargoFile}`,
    `${HERE}../../native/iroh-js/prebuilt/${triple.dir}/${triple.cargoFile}`,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    tried.push(candidate);
    if (exists(candidate)) return { status: "ok", path: candidate };
  }
  return { status: "not-found", tried };
}
