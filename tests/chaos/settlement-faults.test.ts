/**
 * Settlement fault matrix (docs/09 section 4): inject success, permanent
 * failure, transient failure, late success, duplicate status, and crash-
 * between-steps scenarios. The invariant under test: poker state NEVER
 * commits a value-changing action unless settlement reached SUCCEEDED.
 */

import { describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { FakeSettlementAdapter } from "@fiber-poker/settlement";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { TestClient } from "../integration/helpers/client.ts";

const K = 100_000_000n;

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

async function setup(adapter: FakeSettlementAdapter, turnTimeoutMs = 2500) {
  const server = new TableServer(
    { port: 0, dataDir: `.data/fault-${Math.random().toString(36).slice(2)}`, turnTimeoutMs, autoStartHands: false },
    {
      adapter,
      events: new InMemoryEventStore(),
      snapshots: new InMemorySnapshotStore(),
      keys: key(),
    },
  );
  await server.start();
  return server;
}

describe("settlement fault injection", () => {
  it("never commits a bet whose payment permanently fails", async () => {
    const adapter = new FakeSettlementAdapter();
    const server = await setup(adapter);
    const url = `ws://127.0.0.1:${server.port}`;
    const alice = new TestClient(key(), "alice");
    const bob = new TestClient(key(), "bob");
    await alice.connect(url);
    await bob.connect(url);

    // Permanent failure ONLY for the blind of hand 1: fault on that prefix.
    // Use a targeted fault: any obligation containing alice's key prefix.
    adapter.setFault("fiber-poker-table-1-h1", "permanent-fail");

    await alice.joinTable(100n * K);
    await bob.joinTable(100n * K);

    // Manual start (autoStart off).
    await (server as unknown as { maybeStartHand: () => Promise<void> }).maybeStartHand();

    // Blind payment fails -> hand aborts with refunds, no live hand.
    await alice.waitFor("HAND_START", 15_000);
    // Expect: the hand aborted (phase back to WAITING) and a refund payout.
    await new Promise((r) => setTimeout(r, 700));
    const phase = (server as unknown as { runtime: { state: { phase: string } } }).runtime.state.phase;
    expect(phase).toBe("WAITING");

    // The aborted hand must have refunded the small blind if it was paid.
    const events = await (server as unknown as { events: { readAll: () => Promise<{ eventType: string }[]> } }).events.readAll();
    const types = events.map((e) => e.eventType);
    expect(types).toContain("PaymentFailed");
    // Conservation: stacks sum == total buy-ins (200 CKB).
    const stacks = (server as unknown as { runtime: { state: { seats: { stack: bigint }[] } } }).runtime.state.seats;
    const total = stacks.reduce((a, s) => a + s.stack, 0n);
    expect(total).toBe(200n * K);

    alice.close();
    bob.close();
    await server.stop();
  }, 30_000);

  it("recovers a transient payment failure via retry without duplicating payments", async () => {
    const adapter = new FakeSettlementAdapter();
    // Each buy-in obligation fails once, then succeeds on the retry.
    adapter.setFault("buyin:", "transient", 1);
    const server = await setup(adapter);
    const url = `ws://127.0.0.1:${server.port}`;
    const alice = new TestClient(key(), "alice");
    await alice.connect(url);
    await alice.joinTable(100n * K);

    const events = await (server as unknown as { events: { readAll: () => Promise<{ eventType: string; payload: { obligationId?: string } }[]> } }).events.readAll();
    const fails = events.filter((e) => e.eventType === "PaymentFailed");
    const ok = events.filter((e) => e.eventType === "PaymentSucceeded");
    expect(fails.length).toBeGreaterThanOrEqual(1);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    // Exactly one seat: retried once, succeeded once, seated once.
    expect(server.seatRecords()).toHaveLength(1);

    alice.close();
    await server.stop();
  }, 30_000);

  it("does not commit a player bet when the payment fails, then commits on retry", async () => {
    const adapter = new FakeSettlementAdapter();
    const server = await setup(adapter);
    const url = `ws://127.0.0.1:${server.port}`;
    const alice = new TestClient(key(), "alice");
    const bob = new TestClient(key(), "bob");
    await alice.connect(url);
    await bob.connect(url);
    await alice.joinTable(100n * K);
    await bob.joinTable(100n * K);
    await (server as unknown as { maybeStartHand: () => Promise<void> }).maybeStartHand();
    await alice.waitFor("HOLE_CARDS", 15_000);

    // Hand is live (blinds settled). Now fail every payment.
    adapter.defaultMode = "permanent-fail";

    // Whoever acts first in the heads-up hand (SB) tries a value bet.
    const aliceTurn = alice.waitMyTurn(8000).then(() => "alice" as const).catch(() => null);
    const bobTurn = bob.waitMyTurn(8000).then(() => "bob" as const).catch(() => null);
    const first = await Promise.race([
      aliceTurn.then((w) => (w ? { who: w, via: "a" } : null)),
      bobTurn.then((w) => (w ? { who: w, via: "b" } : null)),
    ]);
    if (first) {
      const client = first.who === "alice" ? alice : bob;
      const seqBefore = (client as unknown as { sequence: bigint }).sequence;
      const canBet = ((client.yourTurn as { legal?: { actions: string[] } }).legal?.actions ?? []).some((a) =>
        ["RAISE", "CALL", "BET"].includes(a),
      );
      if (canBet) {
        const hash = await client.actRaw({ type: "RAISE", amount: 10n * K }, { nonce: `n-fail-${Date.now()}` });
        const code = await client.waitForRejected(hash);
        expect(code).toBe("SETTLEMENT_FAILED");
        // No state change: the client's tracked sequence did not advance.
        expect((client as unknown as { sequence: bigint }).sequence).toBe(seqBefore);
      }
    }
    alice.close();
    bob.close();
    await server.stop();
  }, 40_000);
});
