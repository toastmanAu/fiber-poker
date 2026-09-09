/**
 * Closure monitoring and dispute-ack tests:
 *  - a force-closed player channel is observed by the table; the seat is
 *    blocked and hands pause until an operator resolves the closure;
 *  - client state acknowledgements (ACK_STATE) are persisted as dispute
 *    evidence, exposed in snapshots, and recovered after restart.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FileEventStore, FileSnapshotStore } from "@fiber-poker/persistence";
import { generateKeyPair } from "@fiber-poker/protocol";
import { FakeSettlementAdapter } from "@fiber-poker/settlement";
import { SimNodeGateway, SimulatedFiberNetwork } from "@fiber-poker/fiber-adapter";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { TestClient } from "../integration/helpers/client.ts";

const K = 100_000_000n;

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

async function startServer(gateway: SimNodeGateway | null) {
  const server = new TableServer(
    { port: 0, dataDir: `.data/close-${Math.random().toString(36).slice(2)}`, turnTimeoutMs: 60_000, autoStartHands: false },
    {
      adapter: new FakeSettlementAdapter(),
      events: new InMemoryEventStore(),
      snapshots: new InMemorySnapshotStore(),
      keys: key(),
      gateway,
    },
  );
  await server.start();
  return server;
}

describe("channel closure monitoring", () => {
  it("blocks the seat and pauses hands on force-close, then resumes after operator resolve", async () => {
    const net = new SimulatedFiberNetwork();
    const [table, player] = net.addRandomNodes(2, 10_000n * K);
    const gateway = net.node(table);
    const server = await startServer(gateway);

    // Seat a player through the normal flow (channel opened by the table).
    const alice = new TestClient(key(), "alice");
    // The TestClient identity key must match the sim node the table opened a
    // channel to; the table opens its own channel to alice's pubkey, so add
    // that pubkey as a sim node before joining.
    const bob = new TestClient(key(), "bob");
    net.addNode({ pubkey: alice.pubkey, balance: 10_000n * K });
    net.addNode({ pubkey: bob.pubkey, balance: 10_000n * K });
    void player;

    const url = `ws://127.0.0.1:${server.port}`;
    await alice.connect(url);
    await bob.connect(url);
    await alice.joinTable(100n * K);
    await bob.joinTable(100n * K);
    expect(server.seatRecords()).toHaveLength(2);

    // The table (gateway node) force-closes alice's channel; the unilateral
    // close matures on-chain after the dispute delay.
    await gateway.forceCloseTo(alice.pubkey);
    net.tick();
    net.tick();
    const closed = await (server as unknown as { checkChannelClosures: () => Promise<string[]> }).checkChannelClosures();
    expect(closed).toEqual([alice.pubkey]);
    expect(server.blockedSeatIds()).toEqual([alice.pubkey]);
    expect(server.liquidity.snapshot.length >= 0).toBe(true);

    // Hands are paused while a closure is unresolved.
    expect((server as unknown as { liquidity: { canStartHand: (m: Map<string, bigint>) => { ok: boolean } } }).liquidity.canStartHand(new Map()).ok).toBe(false);

    // A closure event was persisted.
    const events = await (server as unknown as { events: { readAll: () => Promise<{ eventType: string }[]> } }).events.readAll();
    const closedEvent = events.find((e) => e.eventType === "ChannelClosed");
    expect(closedEvent).toBeTruthy();

    // Operator resolves: channel re-established, block cleared.
    const resolution = await (server as unknown as { resolveClosure: (id: string) => Promise<{ resolved: boolean }> }).resolveClosure(alice.pubkey);
    expect(resolution.resolved).toBe(true);
    expect(server.blockedSeatIds()).toEqual([]);
    expect((server as unknown as { liquidity: { canStartHand: (m: Map<string, bigint>) => { ok: boolean } } }).liquidity.canStartHand(new Map()).ok).toBe(true);

    alice.close();
    bob.close();
    await server.stop();
  }, 45_000);

  it("does not flag players whose channels are still open", async () => {
    const net = new SimulatedFiberNetwork();
    const [table] = net.addRandomNodes(1, 10_000n * K);
    const server = await startServer(net.node(table));
    const alice = new TestClient(key(), "alice");
    net.addNode({ pubkey: alice.pubkey, balance: 10_000n * K });
    await alice.connect(`ws://127.0.0.1:${server.port}`);
    await alice.joinTable(100n * K);

    const closed = await (server as unknown as { checkChannelClosures: () => Promise<string[]> }).checkChannelClosures();
    expect(closed).toEqual([]);
    expect(server.blockedSeatIds()).toEqual([]);

    alice.close();
    await server.stop();
  }, 45_000);
});

describe("state acknowledgement dispute evidence", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "fiber-poker-acks-"));
  let server2: TableServer | null = null;
  afterAll(async () => {
    await server2?.stop().catch(() => undefined);
  });

  it("persists acks, exposes them in snapshots, and recovers them after restart", async () => {
    // File-backed so the second life can replay the ack events.
    server2 = new TableServer(
      { port: 0, dataDir, turnTimeoutMs: 60_000, autoStartHands: false },
      {
        adapter: new FakeSettlementAdapter(),
        events: new FileEventStore(join(dataDir, "events.ndjson")),
        snapshots: new FileSnapshotStore(join(dataDir, "snapshot.json")),
        keys: key(),
      },
    );
    await server2.start();
    const server = server2;
    const url = `ws://127.0.0.1:${server.port}`;
    const alice = new TestClient(key(), "alice");
    await alice.connect(url);
    await alice.joinTable(100n * K);

    // Client acks the latest chain tip.
    const tip = (server as unknown as { runtime: { tip: { sequence: bigint; stateHash: string } } }).runtime.tip;
    alice.sendRaw("ACK_STATE", { sequence: tip.sequence.toString(), stateHash: tip.stateHash });
    await new Promise((r) => setTimeout(r, 200));

    // Persisted + tracked.
    expect(server.acksFor(alice.pubkey)?.stateHash).toBe(tip.stateHash);
    const events = await (server as unknown as { events: { readAll: () => Promise<{ eventType: string; payload: Record<string, unknown> }[]> } }).events.readAll();
    expect(events.some((e) => e.eventType === "StateAckRecorded")).toBe(true);

    // Exposed in snapshots (skip snapshots taken before the ack existed).
    alice.sendRaw("RESYNC", {});
    const snap = await alice.waitFor("TABLE_SNAPSHOT", 5000, (m) =>
      ((m.payload as { acks?: { stateHash: string }[] }).acks ?? []).some((a) => a.stateHash === tip.stateHash),
    ).catch(() => null);
    expect(snap).not.toBeNull();
    const acks = (snap!.payload as { acks?: { playerId: string; stateHash: string }[] }).acks ?? [];
    expect(acks.some((a) => a.playerId === alice.pubkey && a.stateHash === tip.stateHash)).toBe(true);

    // Malformed acks are rejected.
    alice.sendRaw("ACK_STATE", { sequence: "abc", stateHash: "zz" });
    const err = await alice.waitFor("ERROR", 5000, (m) => (m.payload as { code?: string }).code === "BAD_ACK").catch(() => null);
    expect(err).not.toBeNull();

    // Duplicate ack is idempotent (no second event).
    const before = (await (server as unknown as { events: { readAll: () => Promise<{ eventType: string }[]> } }).events.readAll())
      .filter((e) => e.eventType === "StateAckRecorded").length;
    alice.sendRaw("ACK_STATE", { sequence: tip.sequence.toString(), stateHash: tip.stateHash });
    await new Promise((r) => setTimeout(r, 200));
    const after = (await (server as unknown as { events: { readAll: () => Promise<{ eventType: string }[]> } }).events.readAll())
      .filter((e) => e.eventType === "StateAckRecorded").length;
    expect(after).toBe(before);

    // --- restart: the ack survives replay ----------------------------------
    await (server as unknown as { stop: () => Promise<void> }).stop();
    const again = new TableServer(
      { port: 0, dataDir, turnTimeoutMs: 60_000, autoStartHands: false },
      {
        adapter: new FakeSettlementAdapter(),
        events: new FileEventStore(join(dataDir, "events.ndjson")),
        snapshots: new FileSnapshotStore(join(dataDir, "snapshot.json")),
        keys: key(),
      },
    );
    server2 = again;
    await again.start();
    await alice.connect(`ws://127.0.0.1:${again.port}`);
    expect(again.acksFor(alice.pubkey)?.stateHash).toBe(tip.stateHash);

    alice.close();
    await again.stop();
  }, 45_000);
});
