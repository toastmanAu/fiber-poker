/**
 * Crash/restart recovery (docs/06 + docs/09 section 7): kill the server at
 * durable boundaries, restart on the same file-backed event store, and
 * verify: state replay integrity (hash chain), exactly-once settlement
 * (no duplicate payments), timer restoration, and conservation.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FileEventStore, FileSnapshotStore } from "@fiber-poker/persistence";
import { generateKeyPair } from "@fiber-poker/protocol";
import { FakeSettlementAdapter } from "@fiber-poker/settlement";
import { TableServer } from "@fiber-poker/table-server";
import { TestClient } from "../integration/helpers/client.ts";

const K = 100_000_000n;

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

function readEvents(path: string): { eventType: string; fiberRef?: string }[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { eventType: string; fiberRef?: string });
}

async function startServer(dataDir: string, adapter: FakeSettlementAdapter): Promise<TableServer> {
  const server = new TableServer(
    { port: 0, dataDir, turnTimeoutMs: 100_000, autoStartHands: false },
    {
      adapter,
      events: new FileEventStore(join(dataDir, "events.ndjson")),
      snapshots: new FileSnapshotStore(join(dataDir, "snapshot.json")),
      keys: key(),
    },
  );
  await server.start();
  return server;
}

describe("crash/restart recovery", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "fiber-poker-recovery-"));
  const adapter = new FakeSettlementAdapter();
  let server: TableServer;

  afterAll(async () => {
    await server?.stop().catch(() => undefined);
  });

  it("survives a hard restart mid-hand: chain intact, timer restored, exactly-once money", async () => {
    // --- first life -------------------------------------------------------
    server = await startServer(dataDir, adapter);
    const alice = new TestClient(key(), "alice");
    const bob = new TestClient(key(), "bob");
    await alice.connect(`ws://127.0.0.1:${server.port}`);
    await bob.connect(`ws://127.0.0.1:${server.port}`);
    await alice.joinTable(100n * K);
    await bob.joinTable(100n * K);

    // Manual start; blinds settle; hand is live preflop with a turn timer armed.
    await (server as unknown as { maybeStartHand: () => Promise<void> }).maybeStartHand();
    await alice.waitFor("HOLE_CARDS", 15_000);

    const runtime1 = server.runtime;
    const tipBefore = { sequence: runtime1.tip.sequence.toString(), stateHash: runtime1.tip.stateHash };
    const eventsBefore = readEvents(join(dataDir, "events.ndjson")).filter(
      (e) => e.eventType !== "RecoveryCompleted",
    );

    // --- hard kill ---------------------------------------------------------
    await (server as unknown as { kill: () => Promise<void> }).kill();

    // --- second life -------------------------------------------------------
    server = await startServer(dataDir, adapter);
    expect(server.runtime.tip.sequence).toBe(BigInt(tipBefore.sequence));
    expect(server.runtime.tip.stateHash).toBe(tipBefore.stateHash);

    // The armed turn timer was restored from TurnTimerStarted events.
    const timers = (server as unknown as { turnTimers: Map<string, NodeJS.Timeout> }).turnTimers;
    expect(timers.size).toBeGreaterThanOrEqual(1);

    // Poker state restored: two seated players with their stacks.
    const seated = server.runtime.state.seats.filter((s) => s.playerId !== null);
    expect(seated).toHaveLength(2);
    // Blinds are committed (handContribution) at PREFLOP: stacks + committed
    // must equal total buy-ins.
    expect(seated.reduce((a, s) => a + s.stack + s.handContribution, 0n)).toBe(200n * K);

    // The restart appended only its own bookkeeping event.
    const eventsAfter = readEvents(join(dataDir, "events.ndjson")).filter(
      (e) => e.eventType !== "RecoveryCompleted",
    );
    expect(eventsAfter.length).toBe(eventsBefore.length);

    // Exactly-once money across restarts.
    const log = readEvents(join(dataDir, "events.ndjson"));
    const settled = log.filter((e) => e.eventType === "PaymentSucceeded" || e.eventType === "PayoutSucceeded");
    const counts = new Map<string, number>();
    for (const e of settled) counts.set(e.fiberRef ?? "", (counts.get(e.fiberRef ?? "") ?? 0) + 1);
    for (const [ref, n] of counts) {
      expect(n, `payment ${ref} settled more than once`).toBe(1);
    }

    // Alice and bob reconnect to the restarted server (same keys -> same
    // seats) and resync their chain view.
    const url2 = `ws://127.0.0.1:${server.port}`;
    await alice.connect(url2);
    await bob.connect(url2);
    await alice.resync();
    await bob.resync();

    // A fresh client can join after recovery; the hand is still live so her
    // seat queues until this hand completes (membership changes between hands).
    const carol = new TestClient(key(), "carol");
    await carol.connect(`ws://127.0.0.1:${server.port}`);
    const joinPromise = carol.joinTable(100n * K).catch(() => undefined);
    await carol.waitFor("SEAT_STATUS", 15_000, (m) => (m.payload as { lifecycle?: string }).lifecycle === "SEAT_QUEUED");

    // Play the live hand out so the queued join applies. After a restart no
    // new YOUR_TURN is emitted for the restored turn, so both clients simply
    // attempt folds; out-of-turn attempts are rejected harmlessly.
    const phase = (): string => server.runtime.state.phase;
    let guard = 0;
    while (!["HAND_COMPLETE", "WAITING"].includes(phase()) && guard++ < 10) {
      for (const c of [alice, bob]) {
        if (!["PREFLOP", "FLOP", "TURN", "RIVER"].includes(phase())) break;
        await c.actRaw({ type: "FOLD" }, { nonce: `n-rec-${Math.random().toString(16).slice(2)}` });
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    await joinPromise; // resolves once PLAYER_JOINED arrives
    expect(server.seatRecords()).toHaveLength(3);
    const conserved = server.runtime.state.seats.reduce(
      (a, s) => a + s.stack + s.handContribution,
      0n,
    );
    expect(conserved).toBe(300n * K);

    alice.close();
    bob.close();
    carol.close();
  }, 45_000);
});
