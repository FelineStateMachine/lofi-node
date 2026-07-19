# Design record: engine-enforced write expiry (`expiresAt` on the submission envelope)

Reference spec for the vendor surface lofi would prefer if jazz offered it: an `expiresAt` field on
the sync submission envelope with an engine-enforced `expired` verdict. Recorded as
FelineStateMachine/lofi#145 (upstream wishes are labeled reference issues; nothing is filed with
jazz). Enforcement at the node layer is designed separately against the same contract in
[write-verdicts](site/write-verdicts.md#expiry).

Target surface: jazz / jazz-napi (engine + sync protocol). Consumer: lofi-node and the lofi effect
system.

## Motivation

A local-first app wants to declare that a pending write past a deadline should retire and trigger
compensation. Client-side retirement alone is unsound: the client can never prove a pending write is
not already in flight, or was not delivered before a crash, so a purely local expiry can compensate
and then watch the write sync anyway. If the write carries its deadline and the sync node refuses
late arrivals, the guarantee inverts — once the client's clock passes the deadline plus the skew
allowance, future acceptance is impossible by construction, which is exactly what makes local
compensation safe, even for a device that never reconnects.

## Requested surface

1. **Optional `expiresAt` on the sealed batch submission envelope.** The deadline belongs on the
   envelope, not in row data: enforcement must read only the declared deadline and an arrival clock,
   never interpret application payloads (which may include client-sealed columns). At the pinned
   alpha the envelope is
   `SealedBatchSubmission { batch_id, mode, target_branch_name,
   batch_digest, members, captured_frontier }`
   — no expiry or deadline field exists anywhere in the submission path. The design adds
   `expires_at` as an optional client-asserted wall-clock timestamp (epoch milliseconds, UTC).
   Absent means "never expires" — every existing write keeps its meaning. The field must be covered
   by the batch digest so it cannot be stripped or altered in transit without invalidating the
   submission; today the digest is computed over the member manifest only (a domain-tagged hash of
   member count, object ids, and row digests), so covering `expires_at` means a new manifest version
   in the digest preimage.

2. **Engine-side comparison at the sync node.** On first authoritative adjudication of a batch, the
   engine compares its own arrival time against `expiresAt` and rejects when
   `arrival > expiresAt + tolerance`. Adjudication happens exactly once and the fate is persisted;
   later fate queries return the persisted fate rather than re-running the clock comparison, so a
   verdict can never flip. Server-to-server propagation of an already-accepted batch is never
   re-adjudicated — expiry gates first acceptance, not replication.

3. **Rejection code `expired` through the existing batch-settlement path.** The refusal surfaces as
   a rejected batch fate with a stable machine-readable `code: "expired"` (reason free-text,
   diagnostics only), with the same three properties `permission_denied` satisfies today:

   - **Correlation**: the rejection carries the originating batch id, on both verdict surfaces
     (`wait()` → `PersistedWriteRejectedError`, and the `onMutationError` fallback event).
   - **Re-derivability**: a batch unacknowledged at disconnect is re-proposed on reconnect and the
     rejection fires then; a disconnect defers the verdict, never swallows it.
   - **Determinism**: waiting again on the batch re-derives the same code across reconnects, from
     the persisted fate.

   No new client machinery is needed: consumers already classify codes through a registry, and
   `expired` classifies as permanent (late arrival is final; a re-send arrives later still).

## Skew policy

Deadlines are client-asserted wall-clock times, so enforcement is only as exact as the two clocks
involved. Requested tolerance: **two minutes**, defined as an engine constant, not a per-deployment
tuning knob (a tunable tolerance would let two nodes adjudicate the same late batch differently).
Rationale: devices with OS time sync sit within seconds of true time; two minutes is a wide margin
above realistic drift while keeping the client-safe give-up point close to the intent's deadline.

The client-side soundness rule this yields: the server accepts until `expiresAt + tolerance` on its
own clock, so a client granting its own clock the same allowance may treat the write as permanently
unacceptable once its local clock passes `expiresAt + 2 × tolerance` — one tolerance for the
server's acceptance window, one for the client's own possible offset.

## Threat model

Honest client only. `expiresAt` protects an app from its own stale intents (a write composed before
a crash, a queue drained days later). It is **not** an integrity control: the writer asserts the
deadline, so a malicious client omits it or writes a fresh one. Nothing about this feature should be
documented as constraining hostile writers; that remains the permission system's job. Consequently a
device whose clock is wrong by more than the tolerance only forfeits the guarantee for its own
writes.

## Minimal API sketch (consumer's perspective)

```ts
// Declaring a deadline on a write (any equivalent placement is fine — per-write
// option, or a batch-level option; the envelope field is what matters):
const handle = db.insert(app.orders, { ... }, { expiresAt: Date.now() + 60_000 });

// Settlement, unchanged from today's shapes:
try {
  await handle.wait({ tier: "global" });
} catch (e) {
  // e instanceof PersistedWriteRejectedError
  // e.batchId === handle.batchId
  // e.code === "expired"        // stable; reason is diagnostics only
}

// Fallback surface for un-awaited writes, unchanged:
db.onMutationError((event) => {
  // event.code === "expired"
  // event.batch.batchId, event.batch.latestSettlement.code === "expired"
});
```

Wire-level sketch: `SealedBatchSubmission` gains an optional `expires_at` (epoch ms) covered by a v2
batch-digest manifest, and `BatchFate::Rejected` — whose `code` is an open string, not a closed
enum, so no wire-format change is needed for the new code — carries `"expired"`. The
`captured_frontier` field is compatibility-only at the pinned alpha (conflicts are validated from
per-row parents) and plays no part in this design. No other message changes.
