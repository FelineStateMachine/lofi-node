# Write verdicts

<!-- Source: FelineStateMachine/lofi-node src/verdict.ts, tests/write_verdict_test.ts,
     tests/write_conflict_test.ts; jazz-tools batch-fate surface at the pinned alpha. -->

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

1. **Correlation.** A rejected write surfaces its machine-readable code with the originating write's
   batch id, on both verdict surfaces.
2. **Re-derivability.** A write unacknowledged at disconnect is re-proposed on reconnect, and the
   rejection fires then. A disconnect cannot swallow a verdict; it only defers it.
3. **Determinism.** Waiting again on a rejected batch re-derives the same verdict, across further
   reconnects. An independent device issuing the same write against the same store state derives the
   same code.

One boundary at the pinned alpha: re-derivability holds for direct writes (plain inserts, updates,
deletes). A **transactional batch committed while offline** does not re-submit its seal on
reconnect, so the store never adjudicates it — the write stays unapplied and waiting on it fails
with a runtime error rather than a verdict. Transactions committed while connected settle normally.

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

The pinned alpha's store can emit four rejection codes over the sync protocol:

| Code                       | Store meaning                                                                                                                                                                                                                                                                   | Class                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `permission_denied`        | The store adjudicated the write and refused it: policy denial under a stale client policy, content that fails the store's column validation, or schema-resolution failure. The `reason` distinguishes them; the class does not.                                                 | `permanent`                  |
| `transaction_conflict`     | A transactional batch staged against a row whose visible frontier moved before the store validated the seal. The store never rebases or retries the losing batch; the row converges to the winner.                                                                              | `permanent`                  |
| `permissions_head_missing` | The store enforces permissions but none were ever published for the app (schema deployed without a permissions head). Publishing permissions later does not revisit the fate; only new batches see the new head.                                                                | `permanent`                  |
| `invalid_batch_submission` | The sealed submission itself is malformed. Not producible through the public API: every trigger is an envelope invariant the client runtime computes itself, and the one author-reachable shape (committing an empty transaction) throws synchronously before any batch exists. | unregistered, so `transient` |

The registry also carries `expired`, classified permanent; its semantics are the
[expiry contract below](#expiry). Codes not in the registry classify as transient by design — an
unrecognized code must never trigger irreversible compensation, because waiting is recoverable and a
wrong `rejected` verdict is not. `invalid_batch_submission` stays unregistered on the same
principle: no rejection carrying it has been observed, so no classification has been demonstrated.
As the upstream code space grows, codes enter the registry here rather than in every consumer.

## Expiry

A write may declare a deadline: a wall-clock instant after which the app no longer wants it
accepted. This section states the expiry contract — what a declared deadline means, how refusal
surfaces, and when a client may safely give up — independent of which component enforces it.
**Nothing enforces it at the pinned Jazz alpha**: no deadline travels on the wire today, no store
rejects a late write, and the `expired` code is never emitted. The enforcement design is in progress
at the node layer. The taxonomy entry and everything below define the behavior any enforcement
commits to, so apps written against this page need no changes when it arrives.

### The deadline is declared outside the payload, and client-asserted

The deadline is asserted by the writing client as a wall-clock time and travels apart from the
write's row data, so that enforcement never depends on interpreting application data: whichever
component enforces expiry reads only the declared deadline and its own arrival clock, never what the
write does. That keeps the contract intact for columns an app seals client-side, and keeps
enforcement implementable by a component that does not evaluate application schemas at all.

### The enforcement rule and the skew tolerance

The enforcing component compares its own arrival time against the declared deadline and refuses the
write when

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
anyway. Enforcement on the store's side of the connection inverts this. A late write is accepted
until `expiresAt` plus the tolerance on the enforcing clock, so once a client — granting its own
clock the same two-minute tolerance — observes its clock pass `expiresAt` plus twice the tolerance,
future acceptance is impossible by construction: one tolerance for the acceptance window, one for
the client's own possible offset. From that instant, retiring the write locally and running
compensation is safe even for a device that never reconnects.

Until enforcement exists, none of this holds: a declared deadline is ignored, an expired-looking
pending write may still be accepted whenever the device reconnects, and clients must keep treating
such writes as pending.

## Pending is not offline

A transient-pending write needs one more input before an app can honestly say "waiting for your sync
node": whether the node is reachable at all. That signal is the
[`/health` endpoint](http-surface.md#health), available in every connection mode, composed
client-side with WebSocket lifecycle events into a single connection observable.
