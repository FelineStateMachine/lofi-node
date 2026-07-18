import { assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import { decodeTicket, encodeTicket } from "../src/ticket.ts";
import {
  decodeClose,
  decodeFrame,
  encodeClose,
  encodeFrame,
  FRAME_BIN,
  FRAME_CLOSE,
  FRAME_TEXT,
} from "../src/tunnel.ts";

Deno.test("ticket round-trips arbitrary addr bytes", () => {
  const addr = crypto.getRandomValues(new Uint8Array(97));
  const ticket = encodeTicket(addr);
  assertEquals(decodeTicket(ticket), addr);
  assertEquals(decodeTicket(`  ${ticket}\n`), addr, "tolerates surrounding whitespace");
});

Deno.test("ticket rejects malformed input without throwing", () => {
  assertStrictEquals(decodeTicket(""), null);
  assertStrictEquals(decodeTicket("LFN1."), null);
  assertStrictEquals(decodeTicket("BGI1.abcd"), null, "doorbearer tickets are not ours");
  assertStrictEquals(decodeTicket("LFN1.!!!not-base64!!!"), null);
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
