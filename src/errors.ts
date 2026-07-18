// Status-code contract for the db-iroh-ffi flat C ABI (src/lib.rs consts).

export const DB_OK = 0;

const CODE_NAMES: Record<number, string> = {
  [-1]: "UNIMPLEMENTED",
  [-2]: "BAD_HANDLE",
  [-3]: "BAD_ARG",
  [-4]: "IO",
  [-5]: "NOT_FOUND",
  [-6]: "CRYPTO",
  [-7]: "PANIC",
};

export const DB_ERR_BAD_HANDLE = -2;
export const DB_ERR_IO = -4;
export const DB_ERR_PANIC = -7;

export class IrohFfiError extends Error {
  readonly code: number;
  constructor(code: number, context: string) {
    super(`iroh ffi ${context}: ${CODE_NAMES[code] ?? "UNKNOWN"} (${code})`);
    this.name = "IrohFfiError";
    this.code = code;
  }
}

/** DB_ERR_PANIC: the ONE handle that panicked is poisoned and must be closed
 * and reopened; other handles and the process are unaffected. */
export class IrohPoisonedError extends IrohFfiError {
  constructor(context: string) {
    super(DB_ERR_PANIC, context);
    this.name = "IrohPoisonedError";
  }
}

export function check(code: number, context: string): void {
  if (code === DB_OK) return;
  if (code === DB_ERR_PANIC) throw new IrohPoisonedError(context);
  throw new IrohFfiError(code, context);
}

/** The iroh mesh layer could not be brought up (missing dylib, unsupported
 * platform, ABI mismatch). The Jazz server itself still works without it. */
export class MeshUnavailableError extends Error {
  constructor(reason: string) {
    super(`iroh mesh unavailable: ${reason}`);
    this.name = "MeshUnavailableError";
  }
}
