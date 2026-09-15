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
