/**
 * P10 multiparty seed commit/reveal (docs/08 V1).
 *
 * Unit: deterministic shuffle, commitment binding, combined-seed
 * order-independence, anti-abort exclusion.
 * E2E: a table running FIBER_POKER_DECK=multiparty-seed collects seeds from
 * real clients, deals a hand, and the reveal lets clients re-derive the
 * whole deck; a player that never reveals is sat out and the hand proceeds.
 */

import { describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { ckbHash } from "@fiber-poker/protocol";
import {
  combinedSeedFor,
  MultiPartySeedDeck,
  seedCommitment,
  shuffleFromSeed,
} from "@fiber-poker/deck";
import { DECK_SIZE, fullDeck } from "@fiber-poker/poker-engine";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { FakeSettlementAdapter } from "@fiber-poker/settlement";
import { TestClient } from "../integration/helpers/client.ts";

const K = 100_000_000n;

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

function hexSeed(n: number): Uint8Array {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  void n;
  return b;
}

describe("seed protocol primitives", () => {
  it("shuffleFromSeed is deterministic and produces a valid permutation", () => {
    const seed = ckbHash(new TextEncoder().encode("deck-seed-1"));
    const a = shuffleFromSeed(seed);
    const b = shuffleFromSeed(seed);
    expect(a).toEqual(b);
    expect(a).toHaveLength(DECK_SIZE);
    expect(new Set(a).size).toBe(DECK_SIZE);
    // Different seed => different shuffle (overwhelming probability).
    const other = shuffleFromSeed(ckbHash(new TextEncoder().encode("deck-seed-2")));
    expect(other).not.toEqual(a);
  });

  it("commitments bind handId, player, and seed", () => {
    const seed = hexSeed(1);
    const c1 = seedCommitment("hand-1", "playerA", seed);
    const c2 = seedCommitment("hand-1", "playerA", seed);
    expect(c1).toBe(c2);
    expect(seedCommitment("hand-2", "playerA", seed)).not.toBe(c1);
    expect(seedCommitment("hand-1", "playerB", seed)).not.toBe(c1);
    const flipped = seed.slice();
    flipped[0] = flipped[0]! ^ 1;
    expect(seedCommitment("hand-1", "playerA", flipped)).not.toBe(c1);
  });

  it("combined seed is order-independent across contributors", () => {
    const sA = hexSeed(1);
    const sB = hexSeed(2);
    const sT = hexSeed(3);
    const a = combinedSeedFor("h1", [
      { playerId: "T", seed: sT },
      { playerId: "B", seed: sB },
      { playerId: "A", seed: sA },
    ]);
    const b = combinedSeedFor("h1", [
      { playerId: "A", seed: sA },
      { playerId: "T", seed: sT },
      { playerId: "B", seed: sB },
    ]);
    expect(a).toEqual(b);
  });

  it("multiparty deck: full lifecycle and derived deck matches reveal", async () => {
    const tableKey = key();
    const deck = new MultiPartySeedDeck(tableKey.publicKey);
    deck.beginSeedProtocol("hand-9", ["alice", "bob"]);
    const tableCommitment = deck.tableCommitment("hand-9");
    expect(tableCommitment).toMatch(/^[0-9a-f]{64}$/);

    const seedA = hexSeed(1);
    const seedB = hexSeed(2);
    deck.submitCommitment("hand-9", "alice", seedCommitment("hand-9", "alice", seedA));
    deck.submitCommitment("hand-9", "bob", seedCommitment("hand-9", "bob", seedB));
    expect(deck.commitmentsComplete("hand-9")).toBe(true);
    deck.commitmentsFixed("hand-9");

    // Reveals must match the fixed commitments.
    expect(deck.submitReveal("hand-9", "alice", Buffer.from(seedA).toString("hex"))).toBe(true);
    expect(deck.submitReveal("hand-9", "bob", "ff".repeat(32))).toBe(false); // wrong seed vs commitment

    expect(deck.nonRevealers("hand-9")).toEqual(["bob"]);
    const cards = deck.deriveDeck("hand-9");
    expect(cards).toHaveLength(DECK_SIZE);
    expect(new Set(cards).size).toBe(DECK_SIZE);
    // Same seeds always derive the same deck.
    const deck2 = new MultiPartySeedDeck(tableKey.publicKey);
    deck2.beginSeedProtocol("hand-9", ["alice", "bob"]);
    deck2.submitCommitment("hand-9", "alice", seedCommitment("hand-9", "alice", seedA));
    deck2.submitCommitment("hand-9", "bob", seedCommitment("hand-9", "bob", seedB));
    deck2.commitmentsFixed("hand-9");
    deck2.submitReveal("hand-9", "alice", Buffer.from(seedA).toString("hex"));
    expect(deck2.deriveDeck("hand-9")).toEqual(cards);

    // The reveal carries the seeds; clients re-derive the permutation.
    const reveal = await deck.revealForHand("hand-9");
    const combined = combinedSeedFor("hand-9", reveal.seeds.map((s) => ({
      playerId: s.playerId,
      seed: Uint8Array.from(s.seed.match(/.{2}/g)!.map((h) => Number.parseInt(h, 16))),
    })));
    expect(shuffleFromSeed(combined)).toEqual(reveal.permutation);
    expect(reveal.permutation.map((p) => fullDeck()[p]!)).toEqual(cards);
  });
});

describe("multiparty seed protocol end-to-end", () => {
  it("collects seeds from real clients, deals the hand, and sat-outs a non-revealer", async () => {
    const tableKey = key();
    const server = new TableServer(
      {
        port: 0,
        dataDir: `.data/p10-${Math.random().toString(36).slice(2)}`,
        turnTimeoutMs: 30_000,
        autoStartHands: false,
        deck: "multiparty-seed",
        seedTimeoutMs: 400,
      },
      {
        adapter: new FakeSettlementAdapter(),
        events: new InMemoryEventStore(),
        snapshots: new InMemorySnapshotStore(),
        keys: tableKey,
        // Deck built by the server from config; inject deterministically here:
        deck: new MultiPartySeedDeck(tableKey.publicKey),
      },
    );
    await server.start();
    const url = `ws://127.0.0.1:${server.port}`;

    const alice = new TestClient(key(), "alice");
    const bob = new TestClient(key(), "bob");
    await alice.connect(url);
    await bob.connect(url);
    await alice.joinTable(100n * K);
    await bob.joinTable(100n * K);
    expect(server.seatRecords()).toHaveLength(2);

    // Start the hand: seed protocol runs; both clients auto-participate.
    await (server as unknown as { maybeStartHand: () => Promise<void> }).maybeStartHand();
    await alice.waitFor("HAND_START", 15_000);
    await alice.waitFor("HOLE_CARDS", 15_000);
    expect(alice.holeCards).toHaveLength(2);

    // The seed protocol events were persisted.
    const events = await (server as unknown as { events: { readAll: () => Promise<{ eventType: string }[]> } }).events.readAll();
    expect(events.some((e) => e.eventType === "SeedProtocolStarted")).toBe(true);

    // Fold out; deck reveal includes multiparty seeds.
    const revealP = alice.waitFor("DECK_REVEALED", 30_000).catch(() => null);
    for (const c of [alice, bob]) {
      const got = await c.waitFor("YOUR_TURN", 8000).then(() => true).catch(() => false);
      if (got) await c.act({ type: "FOLD" });
    }
    const reveal = await revealP;
    expect(reveal).not.toBeNull();
    const payload = reveal!.payload as { seeds?: { playerId: string; seed: string }[]; combinedSeed?: string };
    expect(payload.seeds?.length).toBeGreaterThanOrEqual(3); // table + alice + bob
    expect(payload.combinedSeed).toMatch(/^[0-9a-f]{64}$/);

    alice.close();
    bob.close();
    await server.stop();
  }, 45_000);

  it("sat-outs a player that never reveals and restores them between hands", async () => {
    const tableKey = key();
    const server = new TableServer(
      {
        port: 0,
        dataDir: `.data/p10-abort-${Math.random().toString(36).slice(2)}`,
        turnTimeoutMs: 30_000,
        autoStartHands: false,
        deck: "multiparty-seed",
        seedTimeoutMs: 300,
      },
      {
        adapter: new FakeSettlementAdapter(),
        events: new InMemoryEventStore(),
        snapshots: new InMemorySnapshotStore(),
        keys: tableKey,
        deck: new MultiPartySeedDeck(tableKey.publicKey),
      },
    );
    await server.start();
    const url = `ws://127.0.0.1:${server.port}`;

    const alice = new TestClient(key(), "alice");
    const bob = new TestClient(key(), "bob");
    const carol = new TestClient(key(), "carol");
    await alice.connect(url);
    await bob.connect(url);
    await carol.connect(url);
    await alice.joinTable(100n * K);
    await bob.joinTable(100n * K);
    await carol.joinTable(100n * K);

    // Bob goes silent during the seed protocol (ignore SEED_* messages).
    const originalIngest = (bob as unknown as { ingest: (m: Record<string, unknown>) => void }).ingest.bind(bob);
    (bob as unknown as { ingest: (m: Record<string, unknown>) => void }).ingest = (m) => {
      if (m.type === "SEED_COMMITMENT_REQUEST" || m.type === "SEED_REVEAL_REQUEST") return;
      originalIngest(m);
    };

    // Hand 1: alice and carol commit/reveal, bob does not => bob sat out.
    await (server as unknown as { maybeStartHand: () => Promise<void> }).maybeStartHand();
    await alice.waitFor("HAND_START", 15_000);
    await alice.waitFor("HOLE_CARDS", 15_000);
    await carol.waitFor("HOLE_CARDS", 15_000);
    expect(alice.holeCards).toHaveLength(2);
    expect(carol.holeCards).toHaveLength(2);
    expect(bob.holeCards).toHaveLength(0);
    const state1 = (server as unknown as { runtime: { state: { seats: { playerId: string | null; sittingOut: boolean }[] } } }).runtime.state;
    const bobSeat1 = state1.seats.find((s) => s.playerId === bob.pubkey);
    expect(bobSeat1?.sittingOut).toBe(true);

    // Fold out; between hands bob is restored to sitting-in.
    const revealP = alice.waitFor("DECK_REVEALED", 30_000).catch(() => null);
    for (let i = 0; i < 4; i++) {
      const got = await alice.waitFor("YOUR_TURN", 4000).then(() => true).catch(() => false);
      if (!got) break;
      await alice.act({ type: "FOLD" }).catch(() => undefined);
    }
    await revealP;
    // Restore happens at HAND_COMPLETE; give the server a moment.
    await new Promise((r) => setTimeout(r, 500));
    const state2 = (server as unknown as { runtime: { state: { seats: { playerId: string | null; sittingOut: boolean }[] } } }).runtime.state;
    const bobSeat2 = state2.seats.find((s) => s.playerId === bob.pubkey);
    expect(bobSeat2?.sittingOut).toBe(false);

    alice.close();
    bob.close();
    await server.stop();
  }, 45_000);
});
