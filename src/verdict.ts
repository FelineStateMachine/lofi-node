// Write-verdict taxonomy: classify mutation-error codes so consumers act on
// the code, never on the human-readable reason string.
//
// A Jazz write that reaches the sync server settles into a per-batch fate;
// when that fate is a rejection it carries a machine-readable `code` plus a
// free-text `reason`. The reason is diagnostics only — its wording changes
// between Jazz versions. The code is the contract, and this module is the one
// place that maps codes onto the two actions a consumer can take:
//
// - `permanent`: the store has adjudicated the write and will never accept it.
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
 * The pinned Jazz alpha's server can emit exactly four rejection codes
 * through the batch-settlement path (source: `jazz-tools` crate at the
 * alpha.53 publish commit; the code space is the set of string literals fed
 * into `BatchFate::Rejected`, not a closed enum):
 *
 * - `permission_denied` — the store adjudicated the write and refused it.
 *   Despite the name this is the server's general write-denial code: policy
 *   denial under a stale client policy, content that fails the server's
 *   column validation, and schema-resolution failures all surface under it
 *   (the `reason` differs; the classification does not). Permanent.
 * - `transaction_conflict` — a transactional batch whose staged row's
 *   visible parent frontier moved before the authority validated the seal.
 *   Observed in the harness: the fate is final and deterministic across
 *   reconnects; the engine does not rebase or retry. A retry is a new batch.
 *   Permanent.
 * - `permissions_head_missing` — the store enforces permissions but has no
 *   published permissions head (schema deployed without permissions).
 *   Observed in the harness: a persisted, batch-correlated rejection on both
 *   verdict surfaces. Publishing permissions later does not revisit the
 *   fate. Permanent.
 * - `invalid_batch_submission` — the sealed submission itself is malformed
 *   (empty member list, digest mismatch, rows off the declared branch,
 *   invalid row states, mixed direct/transactional rows). Every trigger is
 *   an envelope invariant the client runtime itself computes, and the one
 *   author-reachable shape (committing an empty transaction) throws
 *   synchronously at the call site — so the code is unreachable from the
 *   public API by construction. It stays out of the registry (classifying
 *   as transient) until a rejection can actually be observed: an unprovoked
 *   permanent entry could authorize compensation on a fate whose semantics
 *   were never demonstrated.
 *
 * Writes that violate the CURRENT locally-known policy or schema never
 * produce a code at all — the client runtime refuses them synchronously at
 * the call site, before any batch exists.
 *
 * `expired` (the store refused the write because it arrived past its declared
 * deadline) is registered permanent: late arrival is final, since waiting or
 * re-sending only arrives later still. No store emits it yet, so the entry is
 * inert until one does. The pinned alpha does use the string `expired` on a
 * different surface — the transport's unauthenticated response, for a
 * rejected JWT — but that surface never reaches this classifier.
 */
export const MUTATION_ERROR_CLASSES: Readonly<Record<string, MutationErrorClass>> = {
  permission_denied: "permanent",
  transaction_conflict: "permanent",
  permissions_head_missing: "permanent",
  expired: "permanent",
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
