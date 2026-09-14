/**
 * P3 polish behaviors (2026-09-14):
 *   1. Capacity auto-provisioning: a player agent whose node is short on
 *      player-side channel capacity opens a funded channel at join, and a
 *      table whose table-side capacity is short auto-provisions at the
 *      liquidity gate instead of refusing the join.
 *   2. Reconnect replay: a player resyncing mid-hand gets their hole cards
 *      and (when it is their turn) a YOUR_TURN with the ORIGINAL deadline.
 *   3. Abandoned-payment hygiene: a join whose settlement fails leaves the
 *      node-side invoice cancelled (never a stale payable invoice).
 */

import { afterAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { SimulatedFiberNetwork, ensureCapacity, capacityTo } from "@fiber-poker/fiber-adapter";
import { ImmediateFiberSettlement } from "@fiber-poker/settlement";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { TestClient } from "../integration/helpers/client.ts";

const K = 100_000_000n;

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

describe("capacity auto-provisioning (simulated)", () => {
  it("ensureCapacity opens a funded channel when short and skips when sufficient", async () => {
    const net = new SimulatedFiberNetwork();
    const [a, b] = net.addRandomNodes(2, 1_000_000n * K);
    const gw = net.node(a);
    expect(await capacityTo(gw, b)).toBe(0n);
    const cap = await ensureCapacity(gw, b, { min: 50n * K, openFunding: 200n * K, timeoutMs: 30_000 });
    expect(cap).toBeGreaterThanOrEqual(50n * K);
    // Second call with a higher bar opens nothing new until it re-checks.
    const again = await ensureCapacity(gw, b, { min: 20n * K, openFunding: 200n * K, timeoutMs: 30_000 });
    expect(again).toBe(cap);
  }, 60_000);

  it("a player agent seats itself by opening capacity when its node is drained", async () => {
    const net = new SimulatedFiberNetwork();
    const [tableNode, playerNode] = net.addRandomNodes(2, 1_000_000n * K);
    const tableGateway = net.node(tableNode);
    const playerGateway = net.node(playerNode);

    // Give the pair ONE channel, then drain BOTH sides below the buy-in so
    // neither direction could serve the join without a new open.
    await playerGateway.openChannel(tableNode, 30n * K);
    await tableGateway.fundChannelTo(playerNode, 20n * K);
    const seeded = (await tableGateway.listChannels()).find((c) => c.stateName === "ChannelReady")!;
    await net.setChannelBalances(seeded.channelId, 2n * K, 2n * K);

    const adapter = new ImmediateFiberSettlement(tableGateway, {
      pollMs: 25,
      timeoutMs: 30_000,
      resolvePeer: () => playerNode,
    });
    const aliceKey = key();
    const server = new TableServer(
      {
        port: 0,
        dataDir: `.data/cap-${Math.random().toString(36).slice(2)}`,
        autoStartHands: false,
        peerMapJson: JSON.stringify({ [aliceKey.publicKey]: playerNode }),
      },
      {
        gateway: tableGateway,
        adapter,
        events: new InMemoryEventStore(),
        snapshots: new InMemorySnapshotStore(),
        keys: key(),
      },
    );
    await server.start();
    adapter.onPaymentRequest((req) => {
      if (req.invoiceAddress)
        void playerGateway.payInvoice(req.invoiceAddress).catch(() => undefined);
    });

    // The BUYER (agent role) provisions its own side at join.
    const cap = await ensureCapacity(playerGateway, tableNode, {
      min: 3n * K,
      openFunding: 200n * K,
      timeoutMs: 30_000,
    });
    expect(cap).toBeGreaterThanOrEqual(3n * K);

    const alice = new TestClient(aliceKey, "alice");
    await alice.connect(`ws://127.0.0.1:${server.port}`);
    await alice.joinTable(5n * K);
    expect(server.seatRecords()).toHaveLength(1);
    await server.stop();
  }, 60_000);

  it("a table with short payout capacity auto-provisions at the liquidity gate", async () => {
    const net = new SimulatedFiberNetwork();
    const [tableNode, playerNode] = net.addRandomNodes(2, 1_000_000n * K);
    const tableGateway = net.node(tableNode);
    const playerGateway = net.node(playerNode);

    await playerGateway.openChannel(tableNode, 60n * K);
    const seeded = (await tableGateway.listChannels()).find((c) => c.stateName === "ChannelReady")!;
    // Player side 60 (A: the opener), TABLE side only 2 — the gate must
    // auto-provision table-side capacity for a 30 CKB stack.
    await net.setChannelBalances(seeded.channelId, 60n * K, 2n * K);

    const adapter = new ImmediateFiberSettlement(tableGateway, {
      pollMs: 25,
      timeoutMs: 30_000,
      resolvePeer: () => playerNode,
    });
    const aliceKey = key();
    const server = new TableServer(
      {
        port: 0,
        dataDir: `.data/cap-${Math.random().toString(36).slice(2)}`,
        autoStartHands: false,
        peerMapJson: JSON.stringify({ [aliceKey.publicKey]: playerNode }),
      },
      {
        gateway: tableGateway,
        adapter,
        events: new InMemoryEventStore(),
        snapshots: new InMemorySnapshotStore(),
        keys: key(),
      },
    );
    await server.start();
    adapter.onPaymentRequest((req) => {
      if (req.invoiceAddress)
        void playerGateway
          .payInvoice(req.invoiceAddress)
          .catch(() => undefined);
    });

    const alice = new TestClient(aliceKey, "alice");
    await alice.connect(`ws://127.0.0.1:${server.port}`);
    // 30 CKB stack vs 2 CKB of table-side capacity: the gate would refuse
    // without auto-provisioning.
    await alice.joinTable(30n * K);
    expect(server.seatRecords()).toHaveLength(1);
    const ready = (await tableGateway.listChannels()).filter((c) => c.stateName === "ChannelReady");
    const tableSide = ready.reduce((a, c) => a + c.localBalance, 0n);
    expect(tableSide).toBeGreaterThanOrEqual(30n * K);
    await server.stop();
  }, 60_000);
});

describe("abandoned-payment hygiene (simulated)", () => {
  it("a join whose settlement never completes cancels the node-side invoice", async () => {
    const net = new SimulatedFiberNetwork();
    const [tableNode, playerNode] = net.addRandomNodes(2, 1_000_000n * K);
    const tableGateway = net.node(tableNode);
    const playerGateway = net.node(playerNode);

    await playerGateway.openChannel(tableNode, 100n * K);
    await tableGateway.fundChannelTo(playerNode, 300n * K);

    // NOBODY pays the join invoice: the settlement must fail and the
    // adapter must cancel the stale invoice on the node.
    const adapter = new ImmediateFiberSettlement(tableGateway, {
      pollMs: 25,
      timeoutMs: 5_000,
      resolvePeer: () => playerNode,
    });
    let invoiceHash = "";
    adapter.onPaymentRequest((req) => {
      invoiceHash = req.paymentHash;
    });
    const aliceKey = key();
    const server = new TableServer(
      {
        port: 0,
        dataDir: `.data/abandon-${Math.random().toString(36).slice(2)}`,
        autoStartHands: false,
        settlementTimeoutMs: 2_000,
        peerMapJson: JSON.stringify({ [aliceKey.publicKey]: playerNode }),
      },
      {
        gateway: tableGateway,
        adapter,
        events: new InMemoryEventStore(),
        snapshots: new InMemorySnapshotStore(),
        keys: key(),
      },
    );
    await server.start();

    const alice = new TestClient(aliceKey, "alice");
    await alice.connect(`ws://127.0.0.1:${server.port}`);
    await expect(alice.joinTable(10n * K)).rejects.toThrow();
    // The stale invoice must be CANCELLED on the node, never left payable.
    // rc7 may return the invoice as Cancelled or purge it entirely; both
    // prove it can never be paid late.
    await expect
      .poll(() => tableGateway.invoiceStatus(invoiceHash), { timeout: 15_000 })
      .toBeOneOf(["Cancelled", "Unknown"]);
    await server.stop();
  }, 60_000);
});

describe("reconnect replay (simulated)", () => {
  it("resync mid-hand replays hole cards and the player's pending turn", async () => {
    const { startTestServer } = await import("../integration/helpers/server.ts");
    const { server, url } = await startTestServer({ turnTimeoutMs: 60_000, autoStartHands: false });
    const alice = new TestClient(key(), "alice");
    const bob = new TestClient(key(), "bob");
    try {
      await alice.connect(url);
      await bob.connect(url);
      await alice.joinTable(100n * K);
      await bob.joinTable(100n * K);
      await (server as unknown as { maybeStartHand: () => Promise<void> }).maybeStartHand();
      await alice.waitFor("HOLE_CARDS", 15_000);
      await bob.waitFor("HOLE_CARDS", 15_000);

      // Drive BOB's turns until the acting seat is ALICE, then drop her
      // connection with her turn pending.
      for (let i = 0; i < 6; i++) {
        const seat = server.runtime.state.actingSeat;
        if (seat === undefined) break;
        const actorId = server.runtime.state.seats[seat]!.playerId;
        if (actorId === alice.pubkey) break;
        const turn = await bob.waitFor("YOUR_TURN", 20_000).catch(() => null);
        if (!turn) break;
        const legal = (turn.payload as { legal: { actions: string[] } }).legal.actions;
        await bob.act(legal.includes("CHECK") ? { type: "CHECK" } : { type: "CALL" });
      }
      const seat = server.runtime.state.actingSeat;
      expect(seat).toBeDefined();
      expect(server.runtime.state.seats[seat!]!.playerId).toBe(alice.pubkey);
      alice.close();

      // Reconnect + resync: the private view must be replayed.
      await alice.connect(url);
      const replayed = alice.waitFor("YOUR_TURN", 15_000);
      await alice.resync();
      await replayed;
      expect(alice.holeCards).toHaveLength(2);
      expect(server.runtime.state.actingSeat).toBeDefined();
    } finally {
      alice.close();
      bob.close();
      await server.stop();
    }
  }, 90_000);
});
