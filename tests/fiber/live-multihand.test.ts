/**
 * LIVE multi-hand session (gated) — P1: the full table story on real nodes.
 *
 * Same topology as live-agent-hand.test.ts (two PlayerAgents, both behind
 * the ONE player node, docs/15), extended to a real session:
 *   - THREE hands auto-chain with real settlements on every bet,
 *   - the losing seat tops up 5 CKB between hands (queued if a hand is
 *     live) and pays the top-up invoice from its own node,
 *   - both seats cash out: stack payout over the channel, cooperative
 *     shutdown_channel, seats removed — the shared channel may only close
 *     after the LAST seat leaves.
 *
 *   FIBER_POKER_FNN_URL=http://192.168.68.80:8227 \
 *   FIBER_POKER_FNN_TOKEN=<table biscuit> \
 *   FIBER_POKER_PLAYER_FNN_URL=http://192.168.68.102:8231 \
 *   FIBER_POKER_PLAYER_FNN_TOKEN=<player biscuit> \
 *   npx vitest run tests/fiber/live-multihand.test.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { RealFiberGateway } from "@fiber-poker/fiber-adapter";
import { ensureSessionCapacity } from "./helpers/live-topology.ts";
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
const TOP_UP = 5n * K;
const HANDS = 3;

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

async function waitForChannelState(
  gateway: RealFiberGateway,
  channelId: string,
  pred: (stateName: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const channels = await gateway.listChannels();
    const ch = channels.find((c) => c.channelId === channelId);
    const state = ch?.stateName ?? "Gone";
    if (pred(state)) return state;
    if (Date.now() > deadline) return state;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

d("live multi-hand session (top-up + dual cash-out on shared channel)", () => {
  let server: TableServer;
  let tableGateway: RealFiberGateway;
  const agents: PlayerAgent[] = [];

  afterAll(async () => {
    await server?.stop().catch(() => undefined);
  });

  it("plays three hands with a mid-session top-up, then both seats cash out and the channel closes", async () => {
    tableGateway = new RealFiberGateway({ url: TABLE_URL!, authToken: TABLE_TOKEN!, currency: "Fibt" });
    const playerGateway = new RealFiberGateway({ url: PLAYER_URL!, authToken: PLAYER_TOKEN!, currency: "Fibt" });
    const playerPeer = await playerGateway.nodePubkey();
  await ensureSessionCapacity(tableGateway, playerGateway, {
    minPlayerSide: 3n * BUY_IN,
      minTableSide: 3n * BUY_IN,
    openFunding: 200n * K,
  });


    const peerMapJson: Record<string, string> = {};
    const keyDir = `.data/live-multihand-${Math.random().toString(36).slice(2)}`;
    mkdirSync(keyDir, { recursive: true });
    const agentSpecs = (["mh-alice", "mh-bob"] as const).map((name) => {
      const kp = key();
      const keyPath = `${keyDir}/${name}.session.json`;
      writeFileSync(keyPath, JSON.stringify(kp), { mode: 0o600 });
      peerMapJson[kp.publicKey] = playerPeer;
      return { name, keyPath };
    });

    const settleAdapter = new ImmediateFiberSettlement(tableGateway, {
      pollMs: 250,
      timeoutMs: 60_000,
      resolvePeer: (playerId) => peerMapJson[playerId] ?? playerPeer,
    });

    server = new TableServer(
      {
        port: 0,
        dataDir: `.data/live-multihand-${Math.random().toString(36).slice(2)}`,
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
    await Promise.all(agents.map((a) => a.join()));
    expect(server.seatRecords()).toHaveLength(2);

    // Diagnostics: if any phase of the session stalls, dump the server's
    // settlement ledger before failing so the stall point is on the record.
    const dumpDiagnostics = async (tag: string) => {
      const adapter = settleAdapter as ImmediateFiberSettlement;
      console.log(`[diagnostics:${tag}] phase=${server.runtime.state.phase} handNo=${server.runtime.state.handNo}`);
      for (const e of adapter.allEntries()) console.log(`[diagnostics:${tag}]`, JSON.stringify(e));
    };
    try {
      await runSession();
    } catch (err) {
      await dumpDiagnostics("failure");
      throw err;
    }

    async function runSession() {
      // The seats share one channel (the manager reuses the first ready
      // channel to the player node) — remember which one must close later.
      for (const a of agents) expect(server.channels.channelId(a.pubkey)).not.toBeNull();
      const sharedChannelId = server.channels.channelId(agents[0].pubkey)!;
      expect(server.channels.channelId(agents[1].pubkey)).toBe(sharedChannelId);

      // Keep both agents acting across every hand (never resolved: hands
      // chain until the seats empty; the catch guards late timeouts).
      for (const a of agents) void a.playLoop(120).catch(() => undefined);

      // Collect HAND_RESULTs one per hand; top up the chip-loser after the
      // first hand.
      const seenHandIds = new Set<string>();
      let toppedUp = false;
      while (seenHandIds.size < HANDS) {
        const result = await agents[0].waitFor("HAND_RESULT", 300_000, (m) => {
          const id = (m.payload as { handId?: string }).handId ?? "";
          return id !== "" && !seenHandIds.has(id);
        });
        seenHandIds.add((result.payload as { handId: string }).handId);
        if (!toppedUp) {
          toppedUp = true;
          const stackOf = (id: string) =>
            server.runtime.state.seats.find((s) => s.playerId === id)?.stack ?? 0n;
          const loser = stackOf(agents[0].pubkey) <= stackOf(agents[1].pubkey) ? agents[0] : agents[1];
          await loser.topUp(TOP_UP, 300_000);
        }
      }
      expect(server.runtime.state.handNo).toBeGreaterThanOrEqual(HANDS);

      // Conservation: everything bought in (+ the top-up) is on the table.
      const seated = server.runtime.state.seats.filter((s) => s.playerId);
      expect(seated.reduce((a, s) => a + s.stack + s.handContribution, 0n)).toBe(2n * BUY_IN + TOP_UP);

      // Real money sat table-ward while the session ran.
      const channels = await tableGateway.listChannels();
      const shared = channels.find((c) => c.channelId === sharedChannelId);
      expect(shared?.stateName).toBe("ChannelReady");

      // Dual cash-out: seat-by-seat payout then ONE cooperative shutdown.
      await Promise.all(agents.map((a) => a.leave()));
      expect(server.seatRecords()).toHaveLength(0);

      // rc7 cooperative shutdown: the channel leaves ChannelReady (Closing
      // until the on-chain settle confirms, then Closed).
      const endState = await waitForChannelState(
        tableGateway,
        sharedChannelId,
        (s) => s !== "ChannelReady",
        180_000,
      );
      expect(endState).not.toBe("ChannelReady");
    }
  }, 1_200_000);
});
