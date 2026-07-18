import { assert, assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import {
  type AppTicketRecord,
  AppTicketStore,
  decodeAppTicket,
  encodeAppTicket,
  generateSecret,
  looksLikeAppTicket,
  SECRET_LENGTH,
} from "../src/appticket.ts";

Deno.test("secret shape: 43 chars of url-path-safe base64url", () => {
  for (let i = 0; i < 20; i++) {
    const secret = generateSecret();
    assertEquals(secret.length, SECRET_LENGTH);
    assert(/^[A-Za-z0-9_-]+$/.test(secret), `charset: ${secret}`);
  }
});

Deno.test("app ticket round-trips including optional fields", () => {
  const secret = generateSecret();
  const ticket = {
    v: 1 as const,
    appId: crypto.randomUUID(),
    url: `http://192.168.1.10:4802/t/${secret}`,
    label: "phone",
    node: "endpointabc123",
  };
  const decoded = decodeAppTicket(encodeAppTicket(ticket));
  assertEquals(decoded, ticket);
  assertEquals(decodeAppTicket(`  ${encodeAppTicket(ticket)}\n`), ticket, "tolerates whitespace");
});

Deno.test("decode rejects malformed tickets without throwing", () => {
  assertStrictEquals(decodeAppTicket(""), null);
  assertStrictEquals(decodeAppTicket("lofisync1."), null);
  assertStrictEquals(
    decodeAppTicket("endpointabcdef"),
    null,
    "pairing tickets are not app tickets",
  );
  const bad = { v: 1, appId: "x", url: "http://h/wrong-path" };
  assertStrictEquals(
    decodeAppTicket("lofisync1." + btoa(JSON.stringify(bad))),
    null,
    "url must embed /t/<secret>",
  );
  const wsUrl = { v: 1, appId: "x", url: `ws://h/t/${generateSecret()}` };
  assertStrictEquals(
    decodeAppTicket("lofisync1." + btoa(JSON.stringify(wsUrl))),
    null,
    "url must be http(s)",
  );
});

Deno.test("looksLikeAppTicket distinguishes ticket kinds", () => {
  assert(looksLikeAppTicket("lofisync1.abcd"));
  assert(!looksLikeAppTicket("endpointabcd"));
});

Deno.test("store: issue → verify → revoke → verify, with persistence", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = await AppTicketStore.load(dir);
    const { record, secret } = await store.issue("laptop");
    assertEquals(record.label, "laptop");
    assertEquals(record.id, record.secretHash.slice(0, 12));

    const valid = await store.verify(secret);
    assert(valid.status === "valid" && valid.record.id === record.id);
    assertEquals((await store.verify(generateSecret())).status, "unknown");

    await store.revoke(record.id);
    assertEquals((await store.verify(secret)).status, "revoked");

    // A fresh store over the same dir sees the persisted state.
    const reloaded = await AppTicketStore.load(dir);
    assertEquals((await reloaded.verify(secret)).status, "revoked");
    assertEquals((await reloaded.list()).length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("store: external file change is picked up (CLI → daemon hot-reload)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const daemonStore = await AppTicketStore.load(dir);
    assertEquals((await daemonStore.list()).length, 0);

    // A second store instance models the CLI process writing the file.
    const cliStore = await AppTicketStore.load(dir);
    const { record, secret } = await cliStore.issue("issued-by-cli");

    // Force the throttle window to expire, then verify through the daemon.
    await new Promise((r) => setTimeout(r, 1100));
    const seen = await daemonStore.verify(secret);
    assert(
      seen.status === "valid" && seen.record.id === record.id,
      "daemon sees CLI-issued ticket",
    );

    await cliStore.revoke(record.id);
    await new Promise((r) => setTimeout(r, 1100));
    assertEquals(
      (await daemonStore.verify(secret)).status,
      "revoked",
      "daemon sees CLI revocation",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("store: parent revocation cascades to derived tickets", async () => {
  const store = await AppTicketStore.load();
  const { record: parent, secret: parentSecret } = await store.issue("laptop-admin", "provision");
  const { record: child, secret: childSecret } = await store.issue(
    "laptop-admin (sync)",
    "sync",
    parent.id,
  );
  assertEquals(child.parentId, parent.id);
  assertEquals((await store.verify(parentSecret)).status, "valid");
  assertEquals((await store.verify(childSecret)).status, "valid");

  await store.revoke(parent.id);
  assertEquals((await store.verify(parentSecret)).status, "revoked");
  assertEquals(
    (await store.verify(childSecret)).status,
    "revoked",
    "derived ticket rejects exactly like a revoked one",
  );
});

Deno.test("store: issuing against an unknown or revoked parent throws", async () => {
  const store = await AppTicketStore.load();
  await assertRejects(() => store.issue("x", "sync", "no-such-id"), Error, "unknown or revoked");
  const { record } = await store.issue("gone", "provision");
  await store.revoke(record.id);
  await assertRejects(() => store.issue("x", "sync", record.id), Error, "unknown or revoked");
});

Deno.test("store: parentId persists in v1 tickets.json; a removed parent kills the child", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = await AppTicketStore.load(dir);
    const { record: parent } = await store.issue("admin", "provision");
    const { secret: childSecret } = await store.issue("derived", "sync", parent.id);

    const path = `${dir}/tickets.json`;
    const file = JSON.parse(await Deno.readTextFile(path)) as {
      v: number;
      tickets: AppTicketRecord[];
    };
    assertEquals(file.v, 1, "file format stays v1 — parentId is an additive optional field");
    assertEquals(file.tickets.find((t) => t.parentId)?.parentId, parent.id);

    const reloaded = await AppTicketStore.load(dir);
    assertEquals((await reloaded.verify(childSecret)).status, "valid");

    // Remove the parent record entirely: the orphaned child must reject like
    // a revoked ticket.
    file.tickets = file.tickets.filter((t) => t.id !== parent.id);
    await Deno.writeTextFile(path, JSON.stringify(file, null, 2) + "\n");
    const orphaned = await AppTicketStore.load(dir);
    assertEquals((await orphaned.verify(childSecret)).status, "revoked");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("store: in-memory fallback works without a dataDir", async () => {
  const store = await AppTicketStore.load();
  const { secret } = await store.issue();
  assertEquals((await store.verify(secret)).status, "valid");
});

Deno.test("cross-repo fixtures: valid entries decode as expected, invalid reject", async () => {
  const fixtures = JSON.parse(
    await Deno.readTextFile(new URL("../docs/fixtures/app-ticket-fixtures.json", import.meta.url)),
  ) as {
    valid: { name: string; ticket: string; expect: Record<string, string> }[];
    invalid: { name: string; ticket: string }[];
  };
  for (const entry of fixtures.valid) {
    const decoded = decodeAppTicket(entry.ticket);
    assert(decoded !== null, `${entry.name} decodes`);
    assertEquals(decoded.appId, entry.expect.appId, entry.name);
    assertEquals(decoded.scope ?? "sync", entry.expect.scope, entry.name);
    assertEquals(decoded.url, entry.expect.url, entry.name);
  }
  for (const entry of fixtures.invalid) {
    assertStrictEquals(decodeAppTicket(entry.ticket), null, `${entry.name} rejects`);
  }
});
