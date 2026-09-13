/**
 * LIVE six-agent demo (gated) — P1: the full table on real nodes.
 *
 * Six PlayerAgents, all behind the ONE player node (docs/15 shared-node
 * trick), fill every seat (MAX_SEATS=6), play two chained hands with real
 * settlements on every bet, then ALL cash out: seat-by-seat payouts and a
 * single cooperative shutdown_channel after the last seat leaves.
 *
 *   FIBER_POKER_FNN_URL=http://192.168.68.80:8227 \
 *   FIBER_POKER_FNN_TOKEN=<table biscuit> \
 *   FIBER_POKER_PLAYER_FNN_URL=http://192.168.68.102:8231 \
 *   FIBER_POKER_PLAYER_FNN_TOKEN=<player biscuit> \
 *   npx vitest run tests/fiber/live-sixagent.test.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { RealFiberGateway } from "@fiber-poker/fiber-adapter";
import { ImmediateFiberSettlement } from "@fiber-poker/settlement";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { PlayerAgent } from "../../apps/player-agent/src/agent.ts";

const TABLE_URL = process.env.FIBER_POKER_FNN_URL;
const TABLE_TOKEN = process.env.FIBER_POKER_FNN_TOKEN;
const PLAYER_URL = process.env.FIBER_POKER_PLAYER_FNN_URL;
const PLAYER_TOKEN = process.env.FIBER_POKER_PLAYER_FNN_TOKEN;

const GATED = Boolean(TABLE_URL && TABLE_TOKEN && PLAYER_URL && PLAYER_TOKEN);
const d = GATED ? describe : describe.skip;

const K = 100_000_000n;
const BUY_IN = 10n * K;
const SEATS = 6;
const HANDS = 2;

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

d("live six-agent demo (full table behind one player node)", () => {
  let server: TableServer;
  let tableGateway: RealFiberGateway;
  let settleAdapter: ImmediateFiberSettlement;
  const agents: PlayerAgent[] = [];

  afterAll(async () => {
    await server?.stop().catch(() => undefined);
  });

  it("seats six agents, plays two hands with real settlements, cashes out everyone, closes the channel once", async () => {
    tableGateway = new RealFiberGateway({ url: TABLE_URL!, authToken: TABLE_TOKEN!, currency: "Fibt" });
    const playerGateway = new RealFiberGateway({ url: PLAYER_URL!, authToken: PLAYER_TOKEN!, currency: "Fibt" });
    const playerPeer = await playerGateway.nodePubkey();

    const peerMapJson: Record<string, string> = {};
    const keyDir = `.data/live-six-${Math.random().toString(36).slice(2)}`;
    mkdirSync(keyDir, { recursive: true });
    const agentSpecs = Array.from({ length: SEATS }, (_, i) => {
      const kp = key();
      const keyPath = `${keyDir}/agent-${i}.session.json`;
      writeFileSync(keyPath, JSON.stringify(kp), { mode: 0o600 });
      peerMapJson[kp.publicKey] = playerPeer;
      return { name: `six-${i}`, keyPath };
    });

    settleAdapter = new ImmediateFiberSettlement(tableGateway, {
      pollMs: 250,
      timeoutMs: 60_000,
      resolvePeer: (playerId) => peerMapJson[playerId] ?? playerPeer,
    });

    server = new TableServer(
      {
        port: 0,
        dataDir: `.data/live-six-${Math.random().toString(36).slice(2)}`,
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

    for (const { name, keyPath } of agentSpecs) {
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

    const dumpDiagnostics = async (tag: string) => {
      console.log(`[diagnostics:${tag}] phase=${server.runtime.state.phase} handNo=${server.runtime.state.handNo} seats=${server.seatRecords().length}`);
      for (const e of settleAdapter.allEntries()) console.log(`[diagnostics:${tag}]`, JSON.stringify(e));
    };

    try {
      await runSession();
    } catch (err) {
      await dumpDiagnostics("failure");
      throw err;
    }

    async function runSession() {
      await Promise.all(agents.map((a) => a.join()));
      expect(server.seatRecords()).toHaveLength(SEATS);

      // Every seat maps to the SAME channel; exactly one channel is used.
      const sharedChannelIds = new Set(
        agents.map((a) => server.channels.channelId(a.pubkey)).filter((id) => id !== null),
      );
      expect([...sharedChannelIds]).toHaveLength(1);
      const sharedChannelId = [...sharedChannelIds][0]!;

      for (const a of agents) void a.playLoop(200).catch(() => undefined);

      const seenHandIds = new Set<string>();
      while (seenHandIds.size < HANDS) {
        const result = await agents[0].waitFor("HAND_RESULT", 300_000, (m) => {
          const id = (m.payload as { handId?: string }).handId ?? "";
          return id !== "" && !seenHandIds.has(id);
        });
        seenHandIds.add((result.payload as { handId: string }).handId);
      }
      expect(server.runtime.state.handNo).toBeGreaterThanOrEqual(HANDS);

      // Conservation across all six seats, any instant (gotcha #7).
      const seated = server.runtime.state.seats.filter((s) => s.playerId);
      expect(seated).toHaveLength(SEATS);
      expect(seated.reduce((a, s) => a + s.stack + s.handContribution, 0n)).toBe(BigInt(SEATS) * BUY_IN);

      // Everyone cashes out; the shared channel closes exactly once.
      await Promise.all(agents.map((a) => a.leave()));
      expect(server.seatRecords()).toHaveLength(0);

      const deadline = Date.now() + 180_000;
      for (;;) {
        const channels = await tableGateway.listChannels();
        const ch = channels.find((c) => c.channelId === sharedChannelId);
        const state = ch?.stateName ?? "Gone";
        if (state !== "ChannelReady" || Date.now() > deadline) {
          expect(state).not.toBe("ChannelReady");
          break;
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }, 1_200_000);
});
