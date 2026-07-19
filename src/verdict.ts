// Write-verdict taxonomy: classify mutation-error codes so consumers act on
// the code, never on the human-readable reason string.
//
// A Jazz write that reaches the sync server settles into a per-batch fate;
// when that fate is a rejection it carries a machine-readable `code` plus a
// free-text `reason`. The reason is diagnostics only — its wording changes
// between Jazz versions. The code is the contract, and this module is the one
// place that maps codes onto the two actions a consumer can take:
//
// - `permanent`: the store has adjudicated the write and will never accept it
//   (permission denied, and any future validation/schema-enforcement codes).
//   The write's verdict is `rejected`; compensation may run.
// - `transient`: the outcome is not adjudicated (store unreachable, timeout,
//   ticket hiccup). The write stays pending; keep waiting and retrying.
//
// Codes not in the registry classify as `transient` by design: an
// unrecognized code must never trigger irreversible compensation. Waiting is
// recoverable; a wrong `rejected` verdict is not.

/** How a consumer must treat a mutation-error code. */
export type MutationErrorClass = "permanent" | "transient";

/**
 * The registry of known mutation-error codes.
 *
 * The pinned Jazz alpha emits exactly one rejection code over the sync
 * protocol: `permission_denied` (policy denies the operation on the table for
 * this session). Writes that violate the CURRENT locally-known policy or
 * schema never produce a code at all — the client runtime refuses them
 * synchronously at the call site, before any batch exists.
 */
export const MUTATION_ERROR_CLASSES: Readonly<Record<string, MutationErrorClass>> = {
  permission_denied: "permanent",
};

/**
 * Classify a mutation-error code from a rejected batch fate — the `code` on
 * `MutationErrorEvent`, on `PersistedWriteRejectedError`, or on a
 * `BatchFate` of kind `rejected`.
 *
 * Unknown codes classify as `transient`: the consumer keeps the write
 * pending rather than compensating on a code it cannot interpret.
 */
export function classifyMutationError(code: string): MutationErrorClass {
  return MUTATION_ERROR_CLASSES[code] ?? "transient";
}

/** True when {@link classifyMutationError} classifies `code` as permanent —
 * the write is `rejected` and compensation may run. */
export function isPermanentMutationError(code: string): boolean {
  return classifyMutationError(code) === "permanent";
}
