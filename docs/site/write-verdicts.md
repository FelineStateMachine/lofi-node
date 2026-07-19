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
classified permanent. The registry also carries `expired`, classified permanent; its semantics are
the [expiry contract below](#expiry). Codes not in the registry classify as transient by design — an
unrecognized code must never trigger irreversible compensation, because waiting is recoverable and a
wrong `rejected` verdict is not. As the upstream code space grows (validation, schema enforcement),
codes enter the registry here rather than in every consumer.

## Expiry

A write may declare a deadline: a wall-clock instant after which the app no longer wants it
accepted. This section states the enforcement contract. **The pinned Jazz alpha does not enforce
it** — no deadline travels on the wire today, no store rejects a late write, and the `expired` code
is never emitted. The taxonomy entry and everything below define the behavior a store commits to
once enforcement exists, so apps written against this page need no changes when it arrives.

### The deadline is cleartext, and client-asserted

Private transaction payloads are encrypted end to end; neither the sync node's access gate nor the
store's engine can read them. A deadline the store is supposed to enforce therefore cannot live in
the payload — it travels as an optional field on the transaction's cleartext envelope, asserted by
the writing client as a wall-clock time. The store never inspects what the write does, only when it
arrived.

### The enforcement rule and the skew tolerance

The store compares its own arrival time against the declared deadline and refuses the write when

```
arrival > expiresAt + tolerance
```

The refusal surfaces as a rejected batch fate with `code: "expired"`, through the same settlement
path as `permission_denied`, with the same three properties: correlated to the originating batch id,
re-derived on reconnect, and deterministic. `expired` classifies as **permanent**: late arrival is
final, because waiting or re-sending only arrives later still.

The tolerance is **two minutes**. Deadlines are client-asserted wall-clock times, so enforcement is
only as exact as the two clocks involved: devices with OS time sync sit within seconds of true time,
and two minutes is a wide margin above realistic drift while keeping the moment a client may safely
give up close to the intent's own deadline. A device whose clock is wrong by more than the tolerance
forfeits the guarantee for its own writes, which is consistent with the threat model below.

### What expiry is for — and what it is not

The threat model is the **honest client**. A deadline protects an app from its own stale intents: a
write composed before a crash, a queue drained days later, an offer that should not surface after
the window it was meant for. It is not an integrity control. The deadline is asserted by the writer,
so a malicious client simply omits it, or writes a fresh timestamp; nothing about expiry constrains
what a writer can do. Guarantees against hostile writers come from
[permissions](provision-a-store.md), never from expiry.

### The soundness property for clients

Client-side expiry alone is unsound: a client can never prove that a pending write is not already in
flight, or was not delivered before a crash, so compensating locally risks watching the write sync
anyway. Server-side enforcement inverts this. The store accepts a write until `expiresAt` plus the
tolerance on its own clock, so once a client — granting its own clock the same two-minute tolerance
— observes its clock pass `expiresAt` plus twice the tolerance, future acceptance is impossible by
construction: one tolerance for the store's acceptance window, one for the client's own possible
offset. From that instant, retiring the write locally and running compensation is safe even for a
device that never reconnects.

Until enforcement exists, none of this holds: a declared deadline is ignored, an expired-looking
pending write may still be accepted whenever the device reconnects, and clients must keep treating
such writes as pending.

## Pending is not offline

A transient-pending write needs one more input before an app can honestly say "waiting for your sync
node": whether the node is reachable at all. That signal is the
[`/health` endpoint](http-surface.md#health), available in every connection mode, composed
client-side with WebSocket lifecycle events into a single connection observable.
