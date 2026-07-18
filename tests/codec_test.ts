import { assert, assertEquals, assertFalse } from "@std/assert";
import { looksLikeTicket } from "../src/ticket.ts";
import {
  decodeClose,
  decodeFrame,
  encodeClose,
  encodeFrame,
  FRAME_BIN,
  FRAME_CLOSE,
  FRAME_TEXT,
} from "../src/tunnel.ts";

Deno.test("ticket shape check accepts plausible tickets, rejects junk", () => {
  assert(looksLikeTicket("endpointabcdefghijklmnopqrstuvwxyz234567abcdef"));
  assert(looksLikeTicket("  endpointabcdefghijklmnopqrstuvwxyz234567  "), "tolerates whitespace");
  assertFalse(looksLikeTicket(""));
  assertFalse(looksLikeTicket("short"));
  assertFalse(looksLikeTicket("two words that are definitely not a ticket at all"));
});

Deno.test("frame round-trips type + payload", () => {
  const payload = crypto.getRandomValues(new Uint8Array(1024));
  for (const type of [FRAME_TEXT, FRAME_BIN, FRAME_CLOSE]) {
    const decoded = decodeFrame(encodeFrame(type, payload));
    assertEquals(decoded.type, type);
    assertEquals(new Uint8Array(decoded.payload), payload);
  }
});

Deno.test("empty frame decodes to sentinel type", () => {
  assertEquals(decodeFrame(new Uint8Array(0)).type, -1);
});

Deno.test("close payload round-trips code and reason", () => {
  const { code, reason } = decodeClose(encodeClose(4321, "going away"));
  assertEquals(code, 4321);
  assertEquals(reason, "going away");
  assertEquals(decodeClose(new Uint8Array(0)), { code: 1000, reason: "" });
});
