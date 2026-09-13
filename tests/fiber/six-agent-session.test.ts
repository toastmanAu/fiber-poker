/**
 * Six-agent session rehearsal over the simulated fiber network — the full
 * table (MAX_SEATS=6) behind ONE player node, the exact topology of the
 * gated live six-agent demo. Proves the server-side story at scale:
 *   - six seats join on one shared channel (refcount 6),
 *   - hands auto-chain with a real settled payment behind every bet,
 *   - conservation across all six stacks,
 *   - ALL six seats cash out; the shared channel closes exactly once,
 *     after the LAST seat leaves.
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
const SEATS = 6;

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

describe("six-agent session over simulated fiber (shared player node)", () => {
  let server: TableServer;
  const agents: PlayerAgent[] = [];

  afterAll(async () => {
    await server?.stop().catch(() => undefined);
  });

  it("seats a full 6-player table, plays hands, and cashes out everyone with one channel close", async () => {
    const net = new SimulatedFiberNetwork();
    const [table, player] = net.addRandomNodes(2, 5_000_000n * K);
    const tableGateway = net.node(table);
    const playerGateway = net.node(player);

    await playerGateway.openChannel(table, 200n * K);
    const seeded = (await tableGateway.listChannels()).find((c) => c.stateName === "ChannelReady")!;
    await tableGateway.fundChannelTo(player, 400n * K);

    const peerMap: Record<string, string> = {};
    const keyDir = `.data/sim-six-${Math.random().toString(36).slice(2)}`;
    mkdirSync(keyDir, { recursive: true });
    const agentSpecs = Array.from({ length: SEATS }, (_, i) => {
      const kp = key();
      const keyPath = `${keyDir}/agent-${i}.session.json`;
      writeFileSync(keyPath, JSON.stringify(kp), { mode: 0o600 });
      peerMap[kp.publicKey] = player;
      return { name: `sim-six-${i}`, keyPath };
    });

    const settleAdapter = new ImmediateFiberSettlement(tableGateway, {
      pollMs: 25,
      timeoutMs: 30_000,
      resolvePeer: () => player,
    });

    server = new TableServer(
      {
        port: 0,
        dataDir: `.data/sim-six-${Math.random().toString(36).slice(2)}`,
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
    expect(server.seatRecords()).toHaveLength(SEATS);
    expect(server.runtime.state.seats.filter((s) => s.playerId)).toHaveLength(SEATS);

    // All six seats reuse the SAME channel; nothing else was opened.
    const ready = (await tableGateway.listChannels()).filter((c) => c.stateName === "ChannelReady");
    expect(ready).toHaveLength(1);
    expect(ready[0]!.channelId).toBe(seeded.channelId);

    for (const a of agents) void a.playLoop(200).catch(() => undefined);

    // Two full hands with all six seats dealt in.
    const seenHandIds = new Set<string>();
    while (seenHandIds.size < 2) {
      const result = await agents[0].waitFor("HAND_RESULT", 120_000, (m) => {
        const id = (m.payload as { handId?: string }).handId ?? "";
        return id !== "" && !seenHandIds.has(id);
      });
      seenHandIds.add((result.payload as { handId: string }).handId);
    }
    expect(server.runtime.state.handNo).toBeGreaterThanOrEqual(2);

    // Conservation across all six seats, any instant (gotcha #7).
    const seated = server.runtime.state.seats.filter((s) => s.playerId);
    expect(seated.reduce((a, s) => a + s.stack + s.handContribution, 0n)).toBe(BigInt(SEATS) * BUY_IN);

    // Everyone cashes out; the shared channel closes exactly once.
    await Promise.all(agents.map((a) => a.leave()));
    expect(server.seatRecords()).toHaveLength(0);
    const cooperative = net.closureLog().filter((c) => c.mode === "cooperative");
    expect(cooperative).toHaveLength(1);
    expect(net.channelById(seeded.channelId)!.state).toBe("Closed");
  }, 300_000);
});
