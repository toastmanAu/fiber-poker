/**
 * LIVE 2-agent hand (gated) — docs/15 end-to-end.
 *
 * Two PlayerAgents (headless, each holding its own fiber credentials for the
 * SAME player node) join the fiber-mode table server over WS, declare their
 * fiber peer on JOIN_TABLE, auto-pay every PAYMENT_REQUIRED invoice through
 * their node, play a hand, and leave with a real payout.
 *
 *   FIBER_POKER_FNN_URL=http://192.168.68.80:8227 \
 *   FIBER_POKER_FNN_TOKEN=<table biscuit> \
 *   FIBER_POKER_PLAYER_FNN_URL=http://192.168.68.102:8231 \
 *   FIBER_POKER_PLAYER_FNN_TOKEN=<player biscuit> \
 *   npx vitest run tests/fiber/live-agent-hand.test.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { RealFiberGateway } from "@fiber-poker/fiber-adapter";
import { ImmediateFiberSettlement } from "@fiber-poker/settlement";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { PlayerAgent } from "../../apps/player-agent/src/agent.ts";
import { TestClient } from "../integration/helpers/client.ts";

const TABLE_URL = process.env.FIBER_POKER_FNN_URL;
const TABLE_TOKEN = process.env.FIBER_POKER_FNN_TOKEN;
const PLAYER_URL = process.env.FIBER_POKER_PLAYER_FNN_URL;
const PLAYER_TOKEN = process.env.FIBER_POKER_PLAYER_FNN_TOKEN;

const GATED = Boolean(TABLE_URL && TABLE_TOKEN && PLAYER_URL && PLAYER_TOKEN);
const d = GATED ? describe : describe.skip;

const K = 100_000_000n;
const BUY_IN = 10n * K;

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

d("live 2-agent hand (docs/15 player-agent topology)", () => {
  let server: TableServer;
  const agents: PlayerAgent[] = [];

  afterAll(async () => {
    for (const a of agents) a.leave();
    await server?.stop().catch(() => undefined);
  });

  it("two agents join, play a hand with real settlements, and cash out", async () => {
    const tableGateway = new RealFiberGateway({ url: TABLE_URL!, authToken: TABLE_TOKEN!, currency: "Fibt" });
    const playerGateway = new RealFiberGateway({ url: PLAYER_URL!, authToken: PLAYER_TOKEN!, currency: "Fibt" });
    const playerPeer = await playerGateway.nodePubkey();
    const peerMapJson: Record<string, string> = {};
    const keyDir = `.data/live-agents-${Math.random().toString(36).slice(2)}`;
    mkdirSync(keyDir, { recursive: true });

    // Two headless agents, distinct session keys, same backing fiber node.
    // The test OWNS the session keys: generate and persist them first so the
    // peer map is complete BEFORE the server is constructed.
    const agentSpecs = (["agent-alice", "agent-bob"] as const).map((name) => {
      const kp = key();
      const keyPath = `${keyDir}/${name}.session.json`;
      writeFileSync(keyPath, JSON.stringify(kp), { mode: 0o600 });
      peerMapJson[kp.publicKey] = playerPeer;
      return { name, kp, keyPath };
    });

    const settleAdapter = new ImmediateFiberSettlement(tableGateway, {
      pollMs: 250,
      timeoutMs: 60_000,
      resolvePeer: (playerId) => peerMapJson[playerId] ?? playerPeer, // both seats backed by the player node
    });

    server = new TableServer(
      {
        port: 0,
        dataDir: `.data/live-agents-${Math.random().toString(36).slice(2)}`,
        turnTimeoutMs: 30_000,
        peerMapJson: JSON.stringify(peerMapJson),
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

    for (const { name, kp, keyPath } of agentSpecs) {
      agents.push(new PlayerAgent({
        tableUrl: `ws://127.0.0.1:${server.port}`,
        fnnUrl: PLAYER_URL!,
        fnnToken: PLAYER_TOKEN!,
        currency: "Fibt",
        sessionKeyPath: keyPath,
        buyInShannons: BUY_IN,
        label: name,
        policy: "call-station",
      }));
    }

    // Phase 1: both agents join (declares fiber peer; buy-in invoice paid
    // by the agent itself from the player node).
    for (const a of agents) {
      await a.join();
    }
    expect(server.seatRecords()).toHaveLength(2);

    // Phase 2: the hand auto-starts; both agents drive their own turns and
    // auto-pay their betting invoices. Wait for the hand result.
    const resultP = agents[0].waitFor("HAND_RESULT", 180_000).catch(() => null);
    await Promise.all(agents.map((a) => a.playLoop()));
    const result = await resultP;
    expect(result).not.toBeNull();

    // Conservation across both seats at any phase.
    const seats = server.runtime.state.seats.filter((s) => s.playerId);
    expect(seats.reduce((a, s) => a + s.stack + s.handContribution, 0n)).toBe(2n * BUY_IN);

    // Real money moved table-ward: the table node's channels now hold the pot.
    const channels = await tableGateway.listChannels();
    const tableOutbound = channels
      .filter((c) => c.stateName === "ChannelReady" && c.peerPubkey === playerPeer)
      .reduce((a, c) => a + c.localBalance, 0n);
    expect(tableOutbound > 0n).toBe(true);
  }, 300_000);
});
