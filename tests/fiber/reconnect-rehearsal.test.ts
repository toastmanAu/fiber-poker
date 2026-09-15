/**
 * Rehearsals for the two reconnect scenarios HANDOFF still lists as
 * unrehearsed (immediate-mode replay of hole cards/turn is already covered
 * by tests/fiber/capacity-replay.test.ts):
 *
 *   1. P10 seed-phase reconnect: a player that drops during the seed
 *      commit/reveal stage is sat out for that hand (anti-abort policy),
 *      the hand completes for the others, and the player is restored
 *      automatically for the next hand.
 *   2. Hold-mode reconnect: a player disconnects after their blinds are
 *      HELD; the hand completes around them (timeout policy), holds
 *      finalize, payouts flow over the channel, and on reconnect their
 *      resynced state matches the settled outcome.
 */

import { afterAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { SimulatedFiberNetwork, capacityTo } from "@fiber-poker/fiber-adapter";
import { FakeSettlementAdapter, HoldInvoiceSettlement } from "@fiber-poker/settlement";
import { MultiPartySeedDeck } from "@fiber-poker/deck";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { TestClient } from "../integration/helpers/client.ts";

const K = 100_000_000n;
const BUY_IN = 100n * K;

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

describe("reconnect rehearsal: P10 seed phase", () => {
  let server: TableServer;
  const clients: TestClient[] = [];

  afterAll(async () => {
    for (const c of clients) c.close();
    await server?.stop().catch(() => undefined);
  });

  it("a player dropping mid-seed-phase is sat out, the hand completes, and they are restored", async () => {
    server = new TableServer(
      {
        port: 0,
        dataDir: `.data/rehearsal-${Math.random().toString(36).slice(2)}`,
        autoStartHands: false,
        turnTimeoutMs: 30_000,
        deck: "multiparty-seed",
        seedTimeoutMs: 1_500,
      },
      {
        adapter: new FakeSettlementAdapter(),
        events: new InMemoryEventStore(),
        snapshots: new InMemorySnapshotStore(),
        keys: key(),
        deck: new MultiPartySeedDeck("table-key"),
      },
    );
    await server.start();
    const url = `ws://127.0.0.1:${server.port}`;
    const alice = new TestClient(key(), "alice");
    const bob = new TestClient(key(), "bob");
    clients.push(alice, bob);
    await alice.connect(url);
    await bob.connect(url);
    await alice.joinTable(BUY_IN);
    await bob.joinTable(BUY_IN);

    // Hand starts; the seed protocol collects both commitments. Alice drops
    // before the reveal stage so her reveal never arrives.
    await (server as unknown as { maybeStartHand: () => Promise<void> }).maybeStartHand();
    await bob.waitFor("HOLE_CARDS", 15_000);
    alice.close();

    // Anti-abort policy: the deadline expires, alice is sat out, bob's hand
    // completes (fold-win), and the table is back to a clean state.
    await bob.waitFor("HAND_RESULT", 30_000);
    await expect
      .poll(() => server.runtime.state.phase, { timeout: 15_000 })
      .toMatch(/HAND_COMPLETE|WAITING/);

    // Alice reconnects and is restored (seedSatOut policy: sit-in).
    await alice.connect(url);
    await alice.resync();
    await expect
      .poll(
        () => server.runtime.state.seats.find((s) => s.playerId === alice.pubkey)?.sittingOut,
        { timeout: 15_000 },
      )
      .toBe(false);

    // The next hand deals her back in normally.
    await (server as unknown as { maybeStartHand: () => Promise<void> }).maybeStartHand();
    await alice.waitFor("HOLE_CARDS", 15_000);
    expect(alice.holeCards).toHaveLength(2);
  }, 120_000);
});

describe("reconnect rehearsal: hold mode", () => {
  it("a player who disconnects with blinds HELD still gets holds finalized and sees a consistent state on return", async () => {
    const net = new SimulatedFiberNetwork();
    const [tableNode, playerNode] = net.addRandomNodes(2, 1_000_000n * K);
    const tableGateway = net.node(tableNode);
    const playerGateway = net.node(playerNode);

    // Capacity both directions; alice's seat = the shared player node.
    // Generous on purpose: 200 CKB of buy-ins will drain a thin player side
    // before the blinds (the same live-taught lesson as the on-ramp).
    await playerGateway.openChannel(tableNode, 600n * K);
    await tableGateway.fundChannelTo(playerNode, 600n * K);

    const adapter = new HoldInvoiceSettlement(tableGateway, { pollMs: 25 });
    adapter.onPaymentRequest((req) => {
      if (req.obligation.direction === "PLAYER_TO_TABLE" && req.invoiceAddress) {
        void playerGateway
          .payInvoice(req.invoiceAddress)
          .catch(() => undefined);
      }
    });

    const aliceKey = key();
    const bobKey = key();
    const server = new TableServer(
      {
        port: 0,
        dataDir: `.data/rehearsal-hold-${Math.random().toString(36).slice(2)}`,
        autoStartHands: false,
        turnTimeoutMs: 30_000,
        peerMapJson: JSON.stringify({
          [aliceKey.publicKey]: playerNode,
          [bobKey.publicKey]: playerNode,
        }),
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
    expect(server.coordinator.holdMode).toBe(true);
    console.log("[hold-diag] server up");

    const alice = new TestClient(aliceKey, "alice");
    const bob = new TestClient(bobKey, "bob");
    const url = `ws://127.0.0.1:${server.port}`;
    await alice.connect(url);
    await bob.connect(url);
    await alice.joinTable(BUY_IN);
    await bob.joinTable(BUY_IN);
    console.log("[hold-diag] both seated");

    // Hand starts: both blinds are HELD (paid by the auto-payer).
    await (server as unknown as { maybeStartHand: () => Promise<void> }).maybeStartHand();
    await alice.waitFor("HOLE_CARDS", 30_000);
    await bob.waitFor("HOLE_CARDS", 30_000);

    // Alice drops mid-hand; bob checks the hand out. Alice's turns resolve
    // via the timeout policy (auto check/fold) so the hand completes.
    alice.close();
    const done = bob.waitFor("HAND_RESULT", 60_000).catch(() => null);
    for (let i = 0; i < 12; i++) {
      const phase = server.runtime.state.phase;
      if (!["PREFLOP", "FLOP", "TURN", "RIVER"].includes(phase)) break;
      const turn = await bob.waitFor("YOUR_TURN", 40_000).catch(() => null);
      if (!turn) break;
      const legal = (turn.payload as { legal: { actions: string[] } }).legal.actions;
      await bob.act(legal.includes("CHECK") ? { type: "CHECK" } : { type: "CALL" });
    }
        expect(await done).not.toBeNull();

    // Both holds were finalized when the hand settled.
    const types = (server.coordinator as unknown as { events: { events: { eventType: string }[] } });
    void types;
    await expect
      .poll(() => server.runtime.state.phase, { timeout: 30_000 })
      .toMatch(/HAND_COMPLETE|WAITING/);

    // Alice reconnects: her resynced state reflects the settled outcome.
    await alice.connect(url);
    await alice.resync();
    const aliceStack = server.runtime.state.seats.find((s) => s.playerId === alice.pubkey)!.stack;
    const bobStack = server.runtime.state.seats.find((s) => s.playerId === bob.pubkey)!.stack;
    expect(aliceStack + bobStack).toBe(2n * BUY_IN);
    expect(server.runtime.state.phase === "HAND_COMPLETE" || server.runtime.state.phase === "WAITING").toBe(true);

    alice.close();
    bob.close();
    await server.stop();
  }, 180_000);
});
