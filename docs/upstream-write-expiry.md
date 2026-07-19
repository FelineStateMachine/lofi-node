# Upstream ask: server-enforced write expiry (`expiresAt` on the cleartext envelope)

Target: jazz / jazz-napi (engine + sync protocol). Consumer: lofi-node and the lofi effect system.

## Motivation

A local-first app wants to declare that a pending write past a deadline should retire and trigger
compensation. Client-side retirement alone is unsound: the client can never prove a pending write is
not already in flight, or was not delivered before a crash, so a purely local expiry can compensate
and then watch the write sync anyway. If the write carries its deadline and the sync node refuses
late arrivals, the guarantee inverts — once the client's clock passes the deadline plus the skew
allowance, future acceptance is impossible by construction, which is exactly what makes local
compensation safe, even for a device that never reconnects.

## Requested surface

1. **Optional `expiresAt` on the transaction/batch cleartext envelope.** Private transaction
   payloads are encrypted, so the engine cannot inspect them; the deadline must live on the sealed
   batch submission's cleartext envelope (alongside the batch digest and captured frontier), as an
   optional client-asserted wall-clock timestamp (epoch milliseconds, UTC). Absent means "never
   expires" — every existing write keeps its meaning. The field should be covered by the batch
   digest so it cannot be stripped or altered in transit without invalidating the submission.

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

Wire-level sketch: `SealedBatchSubmission` gains an optional `expires_at` (epoch ms), and
`BatchFate::Rejected` carries `code: "expired"`. No other message changes.
