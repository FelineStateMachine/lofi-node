# Write verdicts

<!-- Source: FelineStateMachine/lofi-node src/verdict.ts, tests/write_verdict_test.ts;
     jazz-tools batch-fate surface at the pinned alpha. -->

A lofi app treats every mutation as a durable write that eventually settles: accepted into the
store, or rejected by it. Rejection is what compensation logic (refunds, releasing holds) hangs on,
so its semantics are a contract of the node, not an implementation detail. This page states that
contract as it holds at the pinned Jazz alpha, verified by the lofi-node test suite.

## Where verdicts come from

Every write becomes a batch with a client-generated batch id. The store adjudicates the batch and
the client runtime records the outcome as the batch's fate. Two client surfaces carry a rejection:

- **Awaited writes.** `write.wait({ tier })` rejects with a typed error carrying the originating
  `batchId`, a machine-readable `code`, and a human-readable `reason`.
- **Un-awaited writes.** A fallback `onMutationError` event fires with the same `code`/`reason` plus
  the full batch record (`batch.batchId`, `batch.latestSettlement`), for writes whose awaiter no
  longer exists.

Both surfaces correlate to the originating write by batch id. The `reason` string is diagnostics
only; its wording changes between Jazz versions and must never be matched on.

## Local refusal is not a verdict

The client runtime enforces the policy it currently knows synchronously, at the call site: a write
that the local policy denies throws immediately and no batch ever exists. The store only adjudicates
writes made under a **stale** policy — accepted locally, then denied by a store whose permissions
tightened after the client last synced them. Author-facing effect handlers therefore see two
distinct failure shapes: a synchronous throw (a programming or policy error against known state) and
an asynchronous `rejected` verdict (the store overruled a write it had never seen).

## Rejection properties

Three properties hold, and the node's harness keeps them pinned:

1. **Correlation.** A permission-denied write surfaces `code: "permission_denied"` with the
   originating write's batch id, on both verdict surfaces.
2. **Re-derivability.** A write unacknowledged at disconnect is re-proposed on reconnect, and the
   rejection fires then. A disconnect cannot swallow a verdict; it only defers it.
3. **Determinism.** Waiting again on a rejected batch re-derives the same verdict, across further
   reconnects. An independent device issuing the same write against the same store state derives the
   same code.

## At-least-once, exactly-once: the consumer's duty

Delivery is at-least-once from the store's point of view (unacked batches are re-proposed on every
reconnect) but the fallback event fires **once per runtime lifetime** — a later reconnect does not
re-fire events for batches already settled. A write journal must therefore:

- persist the verdict when it first arrives, keyed by batch id;
- treat any duplicate delivery (for example after an app restart) as idempotent by batch id;
- re-derive a verdict on demand by waiting on the batch, not by expecting the event again.

Compensation handlers keyed by batch id run at most once even when the verdict is observed twice.

## The taxonomy: permanent or transient

A consumer classifies every mutation-error code into one of two actions, using the classification
the package exports (`classifyMutationError`, `MUTATION_ERROR_CLASSES`):

| Class       | Meaning                                              | Consumer action                             |
| ----------- | ---------------------------------------------------- | ------------------------------------------- |
| `permanent` | The store adjudicated the write and never accepts it | Verdict is `rejected`; compensation may run |
| `transient` | No adjudication happened (unreachable, timeout)      | Write stays pending; keep waiting           |

The pinned alpha emits exactly one rejection code over the sync protocol: `permission_denied`,
classified permanent. Codes not in the registry classify as transient by design — an unrecognized
code must never trigger irreversible compensation, because waiting is recoverable and a wrong
`rejected` verdict is not. As the upstream code space grows (validation, schema enforcement), codes
enter the registry here rather than in every consumer.

## Pending is not offline

A transient-pending write needs one more input before an app can honestly say "waiting for your sync
node": whether the node is reachable at all. That signal is the
[`/health` endpoint](http-surface.md#health), available in every connection mode, composed
client-side with WebSocket lifecycle events into a single connection observable.
