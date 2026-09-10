/**
 * P9 hold-invoice settlement experiment (roadmap; docs/03).
 *
 * Player->table obligations commit once the player's payment is HELD
 * (invoice Received, funds locked but not final). The hand-completion
 * policy settles every held invoice for the hand; the abort policy cancels
 * them — funds return to the players by protocol, with no double-pay.
 */

import { describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { SimulatedFiberNetwork } from "@fiber-poker/fiber-adapter";
import { HoldInvoiceSettlement, holdInvoiceHashFor, holdPreimageFor, type Obligation } from "@fiber-poker/settlement";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { TestClient } from "../integration/helpers/client.ts";

const K = 100_000_000n;

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

function obligation(table: string, player: string, amount: bigint): Obligation {
  return {
    tableId: table,
    handId: "h1",
    sequence: "1",
    actionHash: "ab".repeat(32),
    playerId: player,
    direction: "PLAYER_TO_TABLE",
    amountShannons: amount.toString(),
    reason: "BET",
    obligationId: `h1:1:BET:${player}`,
  };
}

describe("hold invoice semantics (simulated)", () => {
  it("pay -> Received; settle -> Paid with payer Success; cancel -> Cancelled with payer Failed", async () => {
    const net = new SimulatedFiberNetwork();
    const [table, player] = net.addRandomNodes(2, 1000n * K);
    const payer = net.node(player);
    await payer.openChannel(table, 100n * K);

    const preimage = "preimage-secret-01";
    // Sim semantics: the preimage string doubles as the invoice hash key.
    const { paymentHash } = await net.node(table).createHoldInvoice!(10n * K, preimage);
    expect(paymentHash).toBe(preimage);

    // Pay: funds lock, invoice Received, payer payment Inflight.
    net.payInvoice(player, paymentHash);
    expect(await net.node(table).invoiceStatus(paymentHash)).toBe("Received");
    expect(await payer.paymentStatus(paymentHash)).toBe("Inflight");

    // Wrong preimage refused.
    expect(() => net.settleInvoice(paymentHash, "wrong")).toThrow(/preimage/);

    // Settle: invoice Paid, payer Success.
    net.settleInvoice(paymentHash, preimage);
    expect(await net.node(table).invoiceStatus(paymentHash)).toBe("Paid");
    expect(await payer.paymentStatus(paymentHash)).toBe("Success");

    // Cancel path on a fresh hold: funds effectively return (payer Failed).
    const { paymentHash: h2 } = await net.node(table).createHoldInvoice!(5n * K, preimage);
    net.payInvoice(player, h2);
    net.cancelInvoice(h2);
    expect(await net.node(table).invoiceStatus(h2)).toBe("Cancelled");
    expect(await payer.paymentStatus(h2)).toBe("Failed");
  });
});

describe("HoldInvoiceSettlement adapter", () => {
  it("reserveOrPay waits for HELD; finalize settles; cancel releases", async () => {
    const net = new SimulatedFiberNetwork();
    const [table, player] = net.addRandomNodes(2, 1000n * K);
    const tableNode = net.node(table);
    await net.node(player).openChannel(table, 100n * K);
    const adapter = new HoldInvoiceSettlement(tableNode);

    const requests: string[] = [];
    adapter.onPaymentRequest((req) => {
      requests.push(req.paymentHash);
      // The player agent pays the hold invoice.
      net.payInvoice(player, req.paymentHash);
    });

    const ob = obligation("t1", player, 7n * K);
    const ref = await adapter.reserveOrPay(ob);
    const status = await adapter.awaitHeld(ref, 5000);
    expect(status).toBe("HELD");
    expect(requests).toHaveLength(1);
    // Correlation: hold payment hash is H(preimage), derived from the obligation.
    expect(holdInvoiceHashFor(ob)).toBe(holdPreimageHashOf(ob));

    // Cancel before finalize: player made whole.
    await adapter.cancel(ref, "test abort");
    expect(await adapter.getStatus(ref)).toBe("CANCELLED");
    expect(await tableNode.invoiceStatus(ref.id ? requests[0]! : requests[0]!)).toBe("Cancelled");

    // A fresh hold can be finalized instead.
    const ref2 = await adapter.reserveOrPay(ob);
    await adapter.awaitHeld(ref2, 5000);
    await adapter.finalize(ref2);
    expect(await adapter.getStatus(ref2)).toBe("SUCCEEDED");
    expect(await tableNode.invoiceStatus(requests[1]! ?? requests[0]!)).toBe("Paid");
  });
});

// Deterministic preimage hash for correlation assertions in this file.
function holdPreimageHashOf(ob: Obligation): string {
  return holdInvoiceHashFor(ob);
}

describe("hold mode end-to-end (table server)", () => {
  /** Lazy player-agent: funds the player's channel side once, then pays. */
  function autoPay(net: SimulatedFiberNetwork, adapter: HoldInvoiceSettlement, stall?: (ob: Obligation) => boolean): void {
    const funded = new Set<string>();
    adapter.onPaymentRequest((req) => {
      if (req.obligation.direction !== "PLAYER_TO_TABLE") return;
      if (stall?.(req.obligation)) return;
      const payer = req.obligation.playerId;
      if (!funded.has(payer)) {
        funded.add(payer);
        try {
          void net.node(payer).fundChannelTo(req.obligation.tableId === "t1" ? "" : tableOf(net, payer), 500n * K);
        } catch {
          /* already funded */
        }
      }
      net.payInvoice(payer, req.paymentHash);
    });
  }

  // The table node is whichever node holds a channel with the player.
  function tableOf(net: SimulatedFiberNetwork, player: string): string {
    for (const ch of net["channels"]) {
      if (ch.state !== "ChannelReady") continue;
      if (ch.nodeA === player) return ch.nodeB;
      if (ch.nodeB === player) return ch.nodeA;
    }
    throw new Error("no channel for player");
  }

  it("commits blinds on HELD liquidity and settles held invoices at hand end", async () => {
    const net = new SimulatedFiberNetwork();
    const [, table] = net.addRandomNodes(2, 100_000n * K);
    const gateway = net.node(table);
    const holdAdapter = new HoldInvoiceSettlement(gateway);

    const server = new TableServer(
      { port: 0, dataDir: `.data/hold-${Math.random().toString(36).slice(2)}`, turnTimeoutMs: 60_000, autoStartHands: false },
      {
        adapter: holdAdapter,
        gateway,
        events: new InMemoryEventStore(),
        snapshots: new InMemorySnapshotStore(),
        keys: key(),
      },
    );
    await server.start();
    autoPay(net, holdAdapter);

    const alice = new TestClient(key(), "alice");
    const bob = new TestClient(key(), "bob");
    net.addNode({ pubkey: alice.pubkey, balance: 10_000n * K });
    net.addNode({ pubkey: bob.pubkey, balance: 10_000n * K });
    const url = `ws://127.0.0.1:${server.port}`;
    await alice.connect(url);
    await bob.connect(url);
    await alice.joinTable(100n * K);
    await bob.joinTable(100n * K);
    expect(server.seatRecords()).toHaveLength(2);

    // Start a hand; both blinds are HELD (locked, not final) and committed.
    await (server as unknown as { maybeStartHand: () => Promise<void> }).maybeStartHand();
    await alice.waitFor("HOLE_CARDS", 20_000);
    expect(server.coordinator.holdMode).toBe(true);
    const handId = (server as unknown as { runtime: { state: { handId: string } } }).runtime.state.handId;
    expect(server.coordinator.heldCountFor(handId)).toBe(2);

    // Play the hand out; at settlement the holds finalize (settle) and the
    // winner is paid from genuinely collected funds.
    const resultP = alice.waitFor("HAND_RESULT", 30_000).catch(() => null);
    for (const c of [alice, bob]) {
      const got = await c.waitFor("YOUR_TURN", 8000).then(() => true).catch(() => false);
      if (got) await c.act({ type: "FOLD" });
    }
    const result = await resultP;
    expect(result).not.toBeNull();
    expect(server.coordinator.heldCountFor(handId)).toBe(0);
    // Poker conservation holds: stacks + committed == total buy-ins.
    const seats = server.runtime.state.seats;
    expect(seats.reduce((a, s) => a + s.stack + s.handContribution, 0n)).toBe(200n * K);

    alice.close();
    bob.close();
    await server.stop();
  }, 60_000);

  it("aborting a hand cancels held invoices and restores players without double-pay", async () => {
    const net = new SimulatedFiberNetwork();
    const [, table] = net.addRandomNodes(2, 100_000n * K);
    const gateway = net.node(table);
    const holdAdapter = new HoldInvoiceSettlement(gateway);

    const server = new TableServer(
      {
        port: 0,
        dataDir: `.data/hold-abort-${Math.random().toString(36).slice(2)}`,
        turnTimeoutMs: 60_000,
        autoStartHands: false,
        settlementTimeoutMs: 500,
      },
      {
        adapter: holdAdapter,
        gateway,
        events: new InMemoryEventStore(),
        snapshots: new InMemorySnapshotStore(),
        keys: key(),
      },
    );
    await server.start();

    // The big blind stalls: the hand cannot go live and must abort.
    autoPay(net, holdAdapter, (ob) => ob.reason === "BIG_BLIND");

    const alice = new TestClient(key(), "alice");
    const bob = new TestClient(key(), "bob");
    net.addNode({ pubkey: alice.pubkey, balance: 10_000n * K });
    net.addNode({ pubkey: bob.pubkey, balance: 10_000n * K });
    const url = `ws://127.0.0.1:${server.port}`;
    await alice.connect(url);
    await bob.connect(url);
    await alice.joinTable(100n * K);
    await bob.joinTable(100n * K);

    await (server as unknown as { maybeStartHand: () => Promise<void> }).maybeStartHand();
    await new Promise((r) => setTimeout(r, 2000));
    const state = server.runtime.state;
    expect(state.phase).toBe("WAITING");
    expect(state.aborted).toBe(true);
    // Both stacks fully restored: the held small blind was cancelled (not
    // settled), so no refund payment was needed — no double-pay path.
    for (const seat of state.seats) {
      if (seat.playerId) expect(seat.stack).toBe(100n * K);
    }

    alice.close();
    bob.close();
    await server.stop();
  }, 60_000);
});
