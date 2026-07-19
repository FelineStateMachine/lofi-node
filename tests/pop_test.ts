// Proof-of-possession tickets against a stub upstream: binding at derive
// time, the challenge/answer exchange, connect-token enforcement for HTTP
// and WS, single-use and cross-ticket refusals, revocation cascade, and the
// cross-repo signature fixtures.

import { assert, assertEquals } from "@std/assert";
import {
  AppTicketStore,
  decodeAppTicket,
  popMessage,
  verifyPopSignature,
} from "../src/appticket.ts";
import { CLOSE_TICKET_REVOKED, startGate } from "../src/gate.ts";

function startStubUpstream() {
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const protocol = req.headers.get("sec-websocket-protocol")?.split(",")[0].trim();
      const { socket, response } = Deno.upgradeWebSocket(req, protocol ? { protocol } : {});
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({ hello: url.pathname + url.search, protocol: protocol ?? null }),
        );
      });
      socket.addEventListener("message", (ev) => socket.send(ev.data));
      return response;
    }
    return new Response(
      JSON.stringify({ path: url.pathname + url.search, method: req.method }),
      { headers: { "content-type": "application/json" } },
    );
  });
  return {
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    close: () => server.shutdown(),
  };
}

async function withGate(
  fn: (ctx: {
    gateUrl: string;
    store: AppTicketStore;
    gate: ReturnType<typeof startGate>;
  }) => Promise<void>,
) {
  const upstream = startStubUpstream();
  const store = await AppTicketStore.load();
  const gate = startGate({
    port: 0,
    hostname: "127.0.0.1",
    target: () => upstream.url,
    mode: "ticket",
    store,
    appId: "stub-app",
    adminSecret: "node-admin-secret",
  });
  try {
    await fn({ gateUrl: `http://127.0.0.1:${gate.port}`, store, gate });
  } finally {
    await gate.close();
    await upstream.close();
  }
}

const b64url = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

async function makeDeviceKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const spki = b64url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  const sign = async (message: Uint8Array) =>
    b64url(
      new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          pair.privateKey,
          message.buffer as ArrayBuffer,
        ),
      ),
    );
  return { spki, sign };
}

/** Enroll: provision ticket → derive with a device key → parse the derived
 * sync secret out of the returned ticket string. */
async function enrollPop(gateUrl: string, store: AppTicketStore, device: { spki: string }) {
  const provision = await store.issue("provision", "provision");
  const res = await fetch(`${gateUrl}/t/${provision.secret}/derive-sync-ticket`, {
    method: "POST",
    body: JSON.stringify({
      label: "phone",
      devicePublicKey: { alg: "ES256", spki: device.spki },
    }),
  });
  assertEquals(res.status, 200);
  const body = await res.json() as { id: string; ticket: string; pop?: boolean };
  assertEquals(body.pop, true);
  const decoded = decodeAppTicket(body.ticket);
  assert(decoded, "derived ticket must decode");
  const secret = new URL(decoded.url).pathname.split("/t/")[1];
  return { provision, derivedId: body.id, secret };
}

async function completePop(
  gateUrl: string,
  secret: string,
  device: { sign(message: Uint8Array): Promise<string> },
  appId = "stub-app",
  ticketId?: string,
) {
  const challengeRes = await fetch(`${gateUrl}/t/${secret}/pop/challenge`, { method: "POST" });
  assertEquals(challengeRes.status, 200);
  const challenge = await challengeRes.json() as { id: string; nonce: string };
  const sig = await device.sign(
    popMessage(appId, ticketId ?? "", challenge.nonce),
  );
  const answerRes = await fetch(`${gateUrl}/t/${secret}/pop/answer`, {
    method: "POST",
    body: JSON.stringify({ v: 1, id: challenge.id, sig }),
  });
  return answerRes;
}

Deno.test("derive binds a device key; deriving without one stays bearer", async () => {
  await withGate(async ({ gateUrl, store }) => {
    const device = await makeDeviceKey();
    const { derivedId } = await enrollPop(gateUrl, store, device);
    const records = await store.list();
    const bound = records.find((r) => r.id === derivedId);
    assert(bound?.pop, "derived record must carry the bound key");
    assertEquals(bound.pop.alg, "ES256");
    assertEquals(bound.pop.spki, device.spki);

    const provision = await store.issue("p2", "provision");
    const res = await fetch(`${gateUrl}/t/${provision.secret}/derive-sync-ticket`, {
      method: "POST",
      body: JSON.stringify({ label: "legacy" }),
    });
    const body = await res.json() as { id: string; pop?: boolean };
    assertEquals(body.pop, undefined);
    const legacy = (await store.list()).find((r) => r.id === body.id);
    assert(legacy && legacy.pop === undefined, "keyless derive must stay bearer");
  });
});

Deno.test("a malformed device key is a 400, not an auth failure", async () => {
  await withGate(async ({ gateUrl, store }) => {
    const provision = await store.issue("p", "provision");
    for (
      const devicePublicKey of [
        { alg: "RS256", spki: "AAAA" },
        { alg: "ES256", spki: "not-a-key" },
        { alg: "ES256" },
      ]
    ) {
      const res = await fetch(`${gateUrl}/t/${provision.secret}/derive-sync-ticket`, {
        method: "POST",
        body: JSON.stringify({ devicePublicKey }),
      });
      assertEquals(res.status, 400);
      assertEquals((await res.json() as { error: string }).error, "invalid_device_key");
    }
  });
});

Deno.test("a bound ticket refuses bare paths and honors the full exchange", async () => {
  await withGate(async ({ gateUrl, store }) => {
    const device = await makeDeviceKey();
    const { derivedId, secret } = await enrollPop(gateUrl, store, device);

    // The bare secret no longer reaches the upstream.
    const bare = await fetch(`${gateUrl}/t/${secret}/echo`);
    assertEquals(bare.status, 401);
    await bare.body?.cancel();

    // Challenge → sign → answer → token.
    const answerRes = await completePop(gateUrl, secret, device, "stub-app", derivedId);
    assertEquals(answerRes.status, 200);
    const { connect } = await answerRes.json() as { connect: string };

    // HTTP rides the token base with the prefix stripped.
    const http = await fetch(`${gateUrl}/t/${secret}/c/${connect}/echo?x=1`);
    assertEquals(http.status, 200);
    assertEquals((await http.json() as { path: string }).path, "/echo?x=1");

    // WS rides it too, preserving the subprotocol.
    const ws = new WebSocket(
      `ws://${new URL(gateUrl).host}/t/${secret}/c/${connect}/sync`,
      ["jazz-sync"],
    );
    const first = await new Promise<string>((resolve, reject) => {
      ws.addEventListener("message", (ev) => resolve(String(ev.data)), { once: true });
      ws.addEventListener("error", () => reject(new Error("ws failed")), { once: true });
    });
    const hello = JSON.parse(first) as { hello: string; protocol: string | null };
    assertEquals(hello.hello, "/sync");
    assertEquals(hello.protocol, "jazz-sync");
    ws.close();
  });
});

Deno.test("wrong keys, consumed challenges, and foreign tokens refuse as one shape", async () => {
  await withGate(async ({ gateUrl, store }) => {
    const device = await makeDeviceKey();
    const intruder = await makeDeviceKey();
    const { derivedId, secret } = await enrollPop(gateUrl, store, device);

    // A signature from the wrong key fails.
    const wrongKey = await completePop(gateUrl, secret, intruder, "stub-app", derivedId);
    assertEquals(wrongKey.status, 401);
    assertEquals((await wrongKey.json() as { error: string }).error, "invalid_ticket");

    // A challenge dies on its first answer, valid or not.
    const challengeRes = await fetch(`${gateUrl}/t/${secret}/pop/challenge`, { method: "POST" });
    const challenge = await challengeRes.json() as { id: string; nonce: string };
    const sig = await device.sign(popMessage("stub-app", derivedId, challenge.nonce));
    const firstUse = await fetch(`${gateUrl}/t/${secret}/pop/answer`, {
      method: "POST",
      body: JSON.stringify({ v: 1, id: challenge.id, sig }),
    });
    assertEquals(firstUse.status, 200);
    await firstUse.body?.cancel();
    const replay = await fetch(`${gateUrl}/t/${secret}/pop/answer`, {
      method: "POST",
      body: JSON.stringify({ v: 1, id: challenge.id, sig }),
    });
    assertEquals(replay.status, 401);
    await replay.body?.cancel();

    // A token minted for one ticket does not open another.
    const secondDevice = await makeDeviceKey();
    const second = await enrollPop(gateUrl, store, secondDevice);
    const secondAnswer = await completePop(
      gateUrl,
      second.secret,
      secondDevice,
      "stub-app",
      second.derivedId,
    );
    const { connect: foreignToken } = await secondAnswer.json() as { connect: string };
    const crossed = await fetch(`${gateUrl}/t/${secret}/c/${foreignToken}/echo`);
    assertEquals(crossed.status, 401);
    await crossed.body?.cancel();

    // A bearer ticket probing the exchange is a configuration error.
    const bearer = await store.issue("plain");
    const probe = await fetch(`${gateUrl}/t/${bearer.secret}/pop/challenge`, { method: "POST" });
    assertEquals(probe.status, 400);
    assertEquals((await probe.json() as { error: string }).error, "pop_not_bound");
  });
});

Deno.test("revoking the parent kills tokens and closes bound sockets", async () => {
  await withGate(async ({ gateUrl, store }) => {
    const device = await makeDeviceKey();
    const { provision, derivedId, secret } = await enrollPop(gateUrl, store, device);
    const answer = await completePop(gateUrl, secret, device, "stub-app", derivedId);
    const { connect } = await answer.json() as { connect: string };

    const ws = new WebSocket(`ws://${new URL(gateUrl).host}/t/${secret}/c/${connect}/sync`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("message", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("ws failed")), { once: true });
    });

    await store.revoke(provision.record.id);
    const closed = await new Promise<number>((resolve) => {
      ws.addEventListener("close", (ev) => resolve(ev.code), { once: true });
    });
    assertEquals(closed, CLOSE_TICKET_REVOKED);

    const after = await fetch(`${gateUrl}/t/${secret}/c/${connect}/echo`);
    assertEquals(after.status, 401);
    await after.body?.cancel();
  });
});

Deno.test("the cross-repo signature fixtures verify", async () => {
  const fixture = JSON.parse(
    await Deno.readTextFile(new URL("../docs/fixtures/pop-fixtures.json", import.meta.url)),
  ) as { spki: string; appId: string; ticketId: string; nonce: string; signature: string };
  const message = popMessage(fixture.appId, fixture.ticketId, fixture.nonce);
  assert(
    await verifyPopSignature(fixture.spki, message, fixture.signature),
    "the fixture signature must verify",
  );
  const tampered = popMessage(fixture.appId, fixture.ticketId, fixture.nonce + "x");
  assert(
    !(await verifyPopSignature(fixture.spki, tampered, fixture.signature)),
    "a tampered message must not verify",
  );
  assert(
    !(await verifyPopSignature("AAAA", message, fixture.signature)),
    "a malformed key must verify false, not throw",
  );
});
