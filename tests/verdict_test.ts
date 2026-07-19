// The taxonomy contract: consumers act on the code's classification, never on
// the reason string, and unknown codes fail safe (keep waiting, never
// compensate).

import { assert, assertEquals } from "@std/assert";
import {
  classifyMutationError,
  isPermanentMutationError,
  MUTATION_ERROR_CLASSES,
} from "../src/verdict.ts";

Deno.test("verdict: permission_denied is permanent", () => {
  assertEquals(classifyMutationError("permission_denied"), "permanent");
  assert(isPermanentMutationError("permission_denied"));
});

Deno.test("verdict: transaction_conflict is permanent", () => {
  assertEquals(classifyMutationError("transaction_conflict"), "permanent");
  assert(isPermanentMutationError("transaction_conflict"));
});

Deno.test("verdict: permissions_head_missing is permanent", () => {
  assertEquals(classifyMutationError("permissions_head_missing"), "permanent");
  assert(isPermanentMutationError("permissions_head_missing"));
});

Deno.test("verdict: expired is permanent", () => {
  assertEquals(classifyMutationError("expired"), "permanent");
  assert(isPermanentMutationError("expired"));
});

Deno.test("verdict: invalid_batch_submission stays unregistered (transient)", () => {
  // Unreachable from the public API by construction (the registry doc comment
  // records why); it must not classify permanent until a rejection carrying it
  // has actually been observed.
  assertEquals(classifyMutationError("invalid_batch_submission"), "transient");
  assertEquals(isPermanentMutationError("invalid_batch_submission"), false);
});

Deno.test("verdict: unknown codes classify transient", () => {
  for (
    const code of ["", "store_unreachable", "some_future_code", "PERMISSION_DENIED", "EXPIRED"]
  ) {
    assertEquals(classifyMutationError(code), "transient", `code ${JSON.stringify(code)}`);
    assertEquals(isPermanentMutationError(code), false);
  }
});

Deno.test("verdict: the registry only holds valid classes", () => {
  for (const [code, klass] of Object.entries(MUTATION_ERROR_CLASSES)) {
    assert(klass === "permanent" || klass === "transient", `code ${code}`);
  }
});
