/**
 * Multi-hand session rehearsal over the simulated fiber network.
 *
 * Topology mirrors the live 2-agent test exactly (docs/15): both agent
 * seats are backed by ONE player node, so they share a single channel.
 * The suite proves the server-side story that the gated live test then
 * re-proves over real wires:
 *   - hands auto-chain with a real settled payment behind every bet,
 *   - a mid-session TOP_UP lands between hands (queued while a hand is
 *     live) with payment-before-commit,
 *   - both seats cash out; the SHARED channel closes exactly once, after
 *     the last seat leaves — earlier leaves must NOT kill the remaining
 *     seat's payout path.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { SimulatedFiberNetwork } from "@fiber-poker/fiber-adapter";
import { ImmediateFiberSettlement } from "@fiber-poker/settlement";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { PlayerAgent } from "../../apps/player-agent/src/agent.ts";

const K = 100_000_000n;
const BUY_IN = 10n * K;
const TOP_UP = 5n * K;

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

describe("multi-hand session over simulated fiber (shared player node)", () => {
  let server: TableServer;
  const agents: PlayerAgent[] = [];

  afterAll(async () => {
    // Play loops may still be polling for turns; stop() drops the sockets.
    await server?.stop().catch(() => undefined);
  });

  it("chains hands, applies a top-up between hands, and closes the shared channel once on dual leave", async () => {
    const net = new SimulatedFiberNetwork();
    const [table, player] = net.addRandomNodes(2, 1_000_000n * K);
    const tableGateway = net.node(table);
    const playerGateway = net.node(player);

    // Seed ONE channel with capacity on both sides (mirrors the live nodes'
    // pre-existing balanced channels): player-funded, then table top-up.
    await playerGateway.openChannel(table, 150n * K);
    const seeded = (await tableGateway.listChannels()).find((c) => c.stateName === "ChannelReady")!;
    await tableGateway.fundChannelTo(player, 300n * K);

    const peerMap: Record<string, string> = {};
    const keyDir = `.data/sim-agents-${Math.random().toString(36).slice(2)}`;
    mkdirSync(keyDir, { recursive: true });
    const agentSpecs = (["sim-alice", "sim-bob"] as const).map((name) => {
      const kp = key();
      const keyPath = `${keyDir}/${name}.session.json`;
      writeFileSync(keyPath, JSON.stringify(kp), { mode: 0o600 });
      peerMap[kp.publicKey] = player;
      return { name, keyPath };
    });

    const settleAdapter = new ImmediateFiberSettlement(tableGateway, {
      pollMs: 25,
      timeoutMs: 30_000,
      resolvePeer: () => player, // both seats backed by the SAME player node
    });

    server = new TableServer(
      {
        port: 0,
        dataDir: `.data/sim-agents-${Math.random().toString(36).slice(2)}`,
        turnTimeoutMs: 30_000,
        peerMapJson: JSON.stringify(peerMap),
      },
      {
        gateway: tableGateway,
        adapter: settleAdapter,
        events: new InMemoryEventStore(),
        snapshots: new InMemorySnapshotStore(),
        keys: key(),
      },
    );
    await server.start();

    for (const { name, keyPath } of agentSpecs) {
      agents.push(new PlayerAgent({
        tableUrl: `ws://127.0.0.1:${server.port}`,
        fnnUrl: "sim://unused",
        fnnToken: "unused",
        currency: "Fibt",
        sessionKeyPath: keyPath,
        buyInShannons: BUY_IN,
        label: name,
        policy: "call-station",
        gateway: playerGateway,
      }));
    }
    await Promise.all(agents.map((a) => a.join()));
    expect(server.seatRecords()).toHaveLength(2);

    // Both seats reuse the SAME channel — no second channel was opened.
    const ready = (await tableGateway.listChannels()).filter((c) => c.stateName === "ChannelReady");
    expect(ready).toHaveLength(1);
    expect(ready[0]!.channelId).toBe(seeded.channelId);

    // Keep both agents acting across every hand (resolved never: hands
    // auto-chain until the seats empty — the .catch guards the late
    // timeout rejections after the test ends).
    for (const a of agents) void a.playLoop(80).catch(() => undefined);

    // Hand 1 completes; the losing seat tops up mid-session.
    const hand1 = await agents[0].waitFor("HAND_RESULT", 120_000);
    const hand1Id = (hand1.payload as { handId: string }).handId;
    const stackOf = (id: string) =>
      server.runtime.state.seats.find((s) => s.playerId === id)?.stack ?? 0n;
    const loser = stackOf(agents[0].pubkey) <= stackOf(agents[1].pubkey) ? agents[0] : agents[1];
    const topupP = loser.topUp(TOP_UP, 120_000);

    // Hand 2 auto-restarts and completes; by then the top-up has been
    // applied (immediately if the window was open, else queued for its end).
    const hand2 = await agents[0].waitFor(
      "HAND_RESULT",
      180_000,
      (m) => (m.payload as { handId: string }).handId !== hand1Id,
    );
    await topupP;
    expect((hand2.payload as { handId: string }).handId).not.toBe(hand1Id);
    // The sim chains hands in milliseconds — hand 3 may already be live here.
    expect(server.runtime.state.handNo).toBeGreaterThanOrEqual(2);

    // Conservation after two hands + top-up: stacks plus in-hand
    // contributions always equal everything bought in (gotcha #7).
    const seated = server.runtime.state.seats.filter((s) => s.playerId);
    expect(seated.reduce((a, s) => a + s.stack + s.handContribution, 0n)).toBe(2n * BUY_IN + TOP_UP);

    // Dual cash-out: payouts flow seat by seat, then the shared channel
    // closes exactly once — after the LAST seat leaves.
    await Promise.all(agents.map((a) => a.leave()));
    expect(server.seatRecords()).toHaveLength(0);
    const cooperative = net.closureLog().filter((c) => c.mode === "cooperative");
    expect(cooperative).toHaveLength(1);
    expect(net.channelById(seeded.channelId)!.state).toBe("Closed");
  }, 300_000);
});
