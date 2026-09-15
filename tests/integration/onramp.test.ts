/**
 * On-ramp flows (P3 polish): the companion as a NEW PLAYER's entry point.
 *
 *   1. --generate-identity: the companion serves the identity IT generated
 *      to the loopback browser on IDENTITY_REQUEST (never operator files),
 *      and the served identity authenticates through the companion.
 *   2. Identity requests are refused when the companion generated nothing.
 *   3. Capacity provisioning: after WELCOME reveals the table's fiber peer,
 *      a companion configured with minCapacityShannons opens a funded
 *      channel when the player side is short — the new player can pay.
 */

import { it, expect } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { PlayerCompanion } from "../../apps/player-agent/src/companion.ts";
import { SimulatedFiberNetwork, capacityTo } from "@fiber-poker/fiber-adapter";
import { generateKeyPair } from "@fiber-poker/protocol";

const K = 100_000_000n;

function message(
  socket: WebSocket,
  type: string,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", receive);
      reject(new Error(`missing ${type}`));
    }, timeoutMs);
    const receive = (data: { toString(): string }) => {
      const m = JSON.parse(data.toString());
      if (m.type === type) {
        clearTimeout(timer);
        socket.off("message", receive);
        resolve(m);
      }
    };
    socket.on("message", receive);
  });
}

function fakeTable(
  fiberPeerPubkey: string,
): Promise<{ server: WebSocketServer; port: number }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const m = JSON.parse(data.toString()) as { type: string };
      if (m.type === "HELLO") {
        socket.send(
          JSON.stringify({
            type: "WELCOME",
            payload: {
              sessionId: "s",
              tablePubkey: "table-poker-key",
              tableId: "t",
              fiberPeerPubkey,
            },
          }),
        );
      }
    });
  });
  return new Promise((resolve) => {
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({ server, port: address.port });
    });
  });
}

it("on-ramp: the companion serves its GENERATED identity to the loopback browser", async () => {
  const generatedKeys = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
  const generated = { privateKey: generatedKeys.privateKey, publicKey: generatedKeys.publicKey };
  const net = new SimulatedFiberNetwork();
  const [tableNode, playerNode] = net.addRandomNodes(2, 1_000_000_000n);
  const { server: fakeTableServer, port: tablePort } = await fakeTable(tableNode);

  const relay = new PlayerCompanion({
    tableUrl: `ws://127.0.0.1:${tablePort}`,
    playerId: generated.publicKey,
    gateway: net.node(playerNode),
    port: 0,
    allowedOrigins: ["http://localhost:5173"],
    generatedIdentity: generated,
  });
  await relay.start();
  let browser: WebSocket | undefined;
  try {
    browser = new WebSocket(`ws://127.0.0.1:${relay.port}`, {
      origin: "http://localhost:5173",
    });
    await new Promise<void>((resolve) => browser!.once("open", resolve));
    browser.send(JSON.stringify({ type: "IDENTITY_REQUEST", payload: {} }));
    const identity = await message(browser, "IDENTITY");
    expect(identity.payload).toMatchObject({
      privateKey: generated.privateKey,
      publicKey: generated.publicKey,
      generated: true,
    });

    // The served identity authenticates: HELLO with it is relayed upstream
    // (the fake table accepts the connection and answers WELCOME).
    browser.send(JSON.stringify({ type: "HELLO", payload: { pubkey: generated.publicKey } }));
    await message(browser, "WELCOME", 5_000);
  } finally {
    browser?.close();
    await relay.stop();
    fakeTableServer.close();
  }
});

it("on-ramp: identity requests are refused when the companion generated nothing", async () => {
  const owner = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
  const net = new SimulatedFiberNetwork();
  const [tableNode, playerNode] = net.addRandomNodes(2, 1_000_000_000n);
  const { server: fakeTableServer, port: tablePort } = await fakeTable(tableNode);

  const relay = new PlayerCompanion({
    tableUrl: `ws://127.0.0.1:${tablePort}`,
    playerId: owner.publicKey,
    gateway: net.node(playerNode),
    port: 0,
    allowedOrigins: ["http://localhost:5173"],
  });
  await relay.start();
  let browser: WebSocket | undefined;
  try {
    browser = new WebSocket(`ws://127.0.0.1:${relay.port}`, {
      origin: "http://localhost:5173",
    });
    await new Promise<void>((resolve) => browser!.once("open", resolve));
    browser.send(JSON.stringify({ type: "IDENTITY_REQUEST", payload: {} }));
    const err = await message(browser, "ERROR");
    console.log("[diag] error payload:", JSON.stringify(err.payload));
    expect(err.payload).toMatchObject({ code: "COMPANION_IDENTITY_DISABLED" });
  } finally {
    browser?.close();
    await relay.stop();
    fakeTableServer.close();
  }
});

it("on-ramp: capacity is provisioned toward the table after WELCOME when short", async () => {
  const net = new SimulatedFiberNetwork();
  const [tableNode, playerNode] = net.addRandomNodes(2, 1_000_000_000_000n);
  const playerGateway = net.node(playerNode);

  // Drain the player side: 2 CKB available, the on-ramp wants 20 CKB.
  await playerGateway.openChannel(tableNode, 30n * K);
  const seeded = (await playerGateway.listChannels()).find((c) => c.stateName === "ChannelReady")!;
  await net.setChannelBalances(seeded.channelId, 2n * K, 2n * K);
  expect(await capacityTo(playerGateway, tableNode)).toBe(2n * K);

  const { server: fakeTableServer, port: tablePort } = await fakeTable(tableNode);
  const owner = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
  const relay = new PlayerCompanion({
    tableUrl: `ws://127.0.0.1:${tablePort}`,
    playerId: owner.publicKey,
    gateway: playerGateway,
    port: 0,
    allowedOrigins: ["http://localhost:5173"],
    minCapacityShannons: 20n * K,
    capacityOpenFundingShannons: 200n * K,
  });
  await relay.start();
  let browser: WebSocket | undefined;
  try {
    browser = new WebSocket(`ws://127.0.0.1:${relay.port}`, {
      origin: "http://localhost:5173",
    });
    await new Promise<void>((resolve) => browser!.once("open", resolve));
    browser.send(
      JSON.stringify({ type: "HELLO", payload: { pubkey: owner.publicKey } }),
    );
    await message(browser, "WELCOME", 5_000);
    // Provisioning runs on WELCOME; the player side must clear the minimum.
    await expect
      .poll(async () => capacityTo(playerGateway, tableNode), { timeout: 30_000, interval: 500 })
      .toBeGreaterThanOrEqual(20n * K);
    // (COMPANION_STATUS CAPACITY_READY is fire-and-forget — the capacity
    // itself is the assertion; the status race is not worth pinning.)
  } finally {
    browser?.close();
    await relay.stop();
    fakeTableServer.close();
  }
});

it("shared funding: two browsers claim distinct identities and the ledger attributes each payment", async () => {
  const net = new SimulatedFiberNetwork();
  const [tableNode, playerNode] = net.addRandomNodes(2, 1_000_000_000_000n);
  const playerGateway = net.node(playerNode);
  await playerGateway.openChannel(tableNode, 100n * K);

  // Two generated identities in the pool.
  const g1 = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
  const g2 = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
  const players = [
    { privateKey: g1.privateKey, publicKey: g1.publicKey, generated: true },
    { privateKey: g2.privateKey, publicKey: g2.publicKey, generated: true },
  ];

  // Fake table: per-connection WELCOME + one real 10 CKB invoice each.
  const invoices = [
    net.node(tableNode).createInvoice(10n * K),
    net.node(tableNode).createInvoice(10n * K),
  ];
  const table = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const connections: WebSocket[] = [];
  table.on("connection", (socket) => {
    connections.push(socket);
    const index = connections.indexOf(socket);
    socket.on("message", (data) => {
      const m = JSON.parse(data.toString()) as { type: string };
      if (m.type === "HELLO") {
        void invoices[index]!.then(({ paymentHash, invoiceAddress }) => {
          socket.send(
            JSON.stringify({
              type: "WELCOME",
              payload: { sessionId: "s", tablePubkey: "k", tableId: "t", fiberPeerPubkey: tableNode },
            }),
          );
          socket.send(
            JSON.stringify({
              type: "PAYMENT_REQUIRED",
              payload: {
                paymentHash,
                invoiceAddress,
                amountShannons: (10n * K).toString(),
                reason: "BET",
                obligationId: `buyin-${index}`,
                direction: "PLAYER_TO_TABLE",
              },
            }),
          );
        });
      }
    });
  });
  await new Promise<void>((resolve) => table.once("listening", resolve));
  const address = table.address();
  if (!address || typeof address === "string") throw new Error();

  const relay = new PlayerCompanion({
    tableUrl: `ws://127.0.0.1:${address.port}`,
    playerId: players[0]!.publicKey,
    gateway: playerGateway,
    port: 0,
    allowedOrigins: ["http://localhost:5173"],
    players,
    payInvoices: true,
  });
  await relay.start();

  const claimed: string[] = [];
  const sockets: WebSocket[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const browser = new WebSocket(`ws://127.0.0.1:${relay.port}`, {
        origin: "http://localhost:5173",
      });
      sockets.push(browser);
      await new Promise<void>((resolve) => browser.once("open", resolve));
      browser.send(JSON.stringify({ type: "IDENTITY_REQUEST", payload: {} }));
      const identity = await message(browser, "IDENTITY");
      const pubkey = String((identity.payload as { publicKey: string }).publicKey);
      claimed.push(pubkey);
      browser.send(JSON.stringify({ type: "HELLO", payload: { pubkey } }));
      // NOTE: no COMPANION_STATUS wait here — WS frames arrive batched, so
      // the ledger poll below is the authoritative wait.
    }
    // Distinct identities per browser.
    expect(claimed[0]).not.toBe(claimed[1]);
    expect(new Set(claimed)).toEqual(new Set([g1.publicKey, g2.publicKey]));

    // Per-player ledger: one 10 CKB payment per identity, attributed.
    const deadline = Date.now() + 15_000;
    while (relay.exportLedger().length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (relay.exportLedger().length < 2) {
      console.log("[diag-shared] ledger:", JSON.stringify(relay.exportLedger()));
      console.log("[diag-shared] invoices paid:", JSON.stringify([
        await net.node(tableNode).invoiceStatus((await invoices[0]!).paymentHash),
        await net.node(tableNode).invoiceStatus((await invoices[1]!).paymentHash),
      ]));
    }
    const byPlayer = new Map(relay.exportLedger().map((e) => [e.playerId, e]));
    expect(byPlayer.size).toBe(2);
    for (const pid of claimed) {
      const entry = byPlayer.get(pid)!;
      expect(entry.amountShannons).toBe((10n * K).toString());
      expect(entry.reason).toBe("BET");
    }
  } finally {
    for (const s of sockets) s.close();
    await relay.stop();
    table.close();
  }
}, 30_000);
