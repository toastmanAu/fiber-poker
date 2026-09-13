/**
 * LIVE crash/restart recovery (gated) — P4: the fake-mode chaos guarantee,
 * re-proven over real Fiber nodes with a file-backed event store.
 *
 * Life 1: two agents buy in for real, a hand starts (blinds settled and
 * committed), then the server is HARD-KILLED mid-hand.
 * Life 2: a fresh process (new gateway + adapter instances, empty memory)
 * recovers from the same FileEventStore: hash chain intact, seats and
 * stacks restored, in-flight payments resolved against the NODE via the
 * persisted payment hashes (no false failures for already-settled blinds),
 * the restored turn timer resolves the hand, and both agents cash out
 * with one cooperative channel close.
 *
 *   FIBER_POKER_FNN_URL=http://192.168.68.80:8227 \
 *   FIBER_POKER_FNN_TOKEN=<table biscuit> \
 *   FIBER_POKER_PLAYER_FNN_URL=http://192.168.68.102:8231 \
 *   FIBER_POKER_PLAYER_FNN_TOKEN=<player biscuit> \
 *   npx vitest run tests/fiber/live-restart.test.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { RealFiberGateway } from "@fiber-poker/fiber-adapter";
import { ensureSessionCapacity } from "./helpers/live-topology.ts";
import { ImmediateFiberSettlement } from "@fiber-poker/settlement";
import { TableServer } from "@fiber-poker/table-server";
import { FileEventStore, FileSnapshotStore } from "@fiber-poker/persistence";
import { PlayerAgent } from "../../apps/player-agent/src/agent.ts";

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

interface LogEvent {
  eventType: string;
  fiberRef?: string;
  payload?: Record<string, unknown>;
}

function readLog(path: string): LogEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LogEvent);
}

function makeServer(dataDir: string, peerMapJson: string): Promise<TableServer> {
  const gateway = new RealFiberGateway({ url: TABLE_URL!, authToken: TABLE_TOKEN!, currency: "Fibt" });
  const adapter = new ImmediateFiberSettlement(gateway, {
    pollMs: 250,
    timeoutMs: 60_000,
    resolvePeer: (playerId) => {
      const map = JSON.parse(peerMapJson) as Record<string, string>;
      return map[playerId] ?? "";
    },
  });
  const server = new TableServer(
    { port: 0, dataDir, turnTimeoutMs: 12_000, autoStartHands: false, peerMapJson },
    {
      gateway,
      adapter,
      events: new FileEventStore(`${dataDir}/events.ndjson`),
      snapshots: new FileSnapshotStore(`${dataDir}/snapshot.json`),
      keys: key(),
    },
  );
  return server.start().then(() => server);
}

d("live crash/restart recovery (file-backed, real nodes)", () => {
  let server: TableServer | undefined;
  let tableGateway: RealFiberGateway | undefined;

  afterAll(async () => {
    await server?.stop().catch(() => undefined);
  });

  it("hard-kills mid-hand, recovers from the event log against the real node, and finishes the session", async () => {
    const dataDir = `.data/live-restart-${Math.random().toString(36).slice(2)}`;
    const tableGatewayEarly = new RealFiberGateway({ url: TABLE_URL!, authToken: TABLE_TOKEN!, currency: "Fibt" });
    const playerGateway = new RealFiberGateway({ url: PLAYER_URL!, authToken: PLAYER_TOKEN!, currency: "Fibt" });
    const playerPeer = await playerGateway.nodePubkey();
    await ensureSessionCapacity(tableGatewayEarly, playerGateway, {
      minPlayerSide: 3n * BUY_IN,
      minTableSide: 3n * BUY_IN,
      openFunding: 200n * K,
    });


    const peerMapJson: Record<string, string> = {};
    const keyDir = `${dataDir}/keys`;
    const agentSpecs = (["rs-alice", "rs-bob"] as const).map((name) => {
      const kp = key();
      writeAgentKey(keyDir, name, kp);
      peerMapJson[kp.publicKey] = playerPeer;
      return { name, pubkey: kp.publicKey };
    });

    // --- life 1: buy in, start a hand, kill mid-hand -----------------------
    server = await makeServer(dataDir, JSON.stringify(peerMapJson));
    tableGateway = new RealFiberGateway({ url: TABLE_URL!, authToken: TABLE_TOKEN!, currency: "Fibt" });

    const agents: PlayerAgent[] = [];
    for (const { name } of agentSpecs) {
      agents.push(new PlayerAgent({
        tableUrl: `ws://127.0.0.1:${server.port}`,
        fnnUrl: PLAYER_URL!,
        fnnToken: PLAYER_TOKEN!,
        currency: "Fibt",
        sessionKeyPath: `${keyDir}/${name}.session.json`,
        buyInShannons: BUY_IN,
        label: name,
        policy: "call-station",
      }));
    }
    try {
      await Promise.all(agents.map((a) => a.join()));
    } catch (err) {
      const adapter = (server as unknown as { adapter: { allEntries: () => unknown[] } }).adapter;
      console.log("[diag] adapter entries:", JSON.stringify(adapter.allEntries()));
      console.log("[diag] alice notifications:", JSON.stringify(
        server.notificationLogFor(Object.keys(peerMapJson)[0]!).slice(-4),
      ));
      console.log("[diag] phase:", server.runtime.state.phase);
      throw err;
    }
    expect(server.seatRecords()).toHaveLength(2);

    await (server as unknown as { maybeStartHand: () => Promise<void> }).maybeStartHand();
    await agents[0].waitFor("HOLE_CARDS", 60_000);

    const tipBefore = { sequence: server.runtime.tip.sequence.toString(), stateHash: server.runtime.tip.stateHash };
    const logBefore = readLog(`${dataDir}/events.ndjson`).filter((e) => e.eventType !== "RecoveryCompleted");
    const sharedChannelId = server.channels.channelId(agents[0].pubkey)!;
    expect(server.channels.channelId(agents[1].pubkey)).toBe(sharedChannelId);

    // HARD KILL: no leave, no hand completion — exactly the chaos premise.
    await (server as unknown as { kill: () => Promise<void> }).kill();
    const failCountBefore = readLog(`${dataDir}/events.ndjson`).filter((e) => e.eventType === "PaymentFailed").length;

    // --- life 2: fresh process, same durable state -------------------------
    server = await makeServer(dataDir, JSON.stringify(peerMapJson));

    // Chain integrity across the restart.
    expect(server.runtime.tip.sequence).toBe(BigInt(tipBefore.sequence));
    expect(server.runtime.tip.stateHash).toBe(tipBefore.stateHash);
    const seated = server.runtime.state.seats.filter((s) => s.playerId !== null);
    expect(seated).toHaveLength(2);
    expect(seated.reduce((a, s) => a + s.stack + s.handContribution, 0n)).toBe(2n * BUY_IN);

    // Reconciliation verdicts: blinds WERE settled before the kill (their
    // PaymentSucceeded is in the log) — recovery must NOT have converted
    // them into failures. No new PaymentFailed may appear.
    const failCountAfter = readLog(`${dataDir}/events.ndjson`).filter((e) => e.eventType === "PaymentFailed").length;
    expect(failCountAfter).toBe(failCountBefore);

    // Exactly-once settlement evidence across both lives.
    const settled = readLog(`${dataDir}/events.ndjson`).filter(
      (e) => e.eventType === "PaymentSucceeded" || e.eventType === "PayoutSucceeded",
    );
    const once = new Map<string, number>();
    for (const e of settled) once.set(e.fiberRef ?? "", (once.get(e.fiberRef ?? "") ?? 0) + 1);
    for (const [ref, n] of once) expect(n, `payment ${ref} settled more than once`).toBe(1);

    // The restored turn timer resolves the live hand (timeout-folds) and
    // the winner is paid over the real channel.
    const reconnected: PlayerAgent[] = [];
    for (const { name } of agentSpecs) {
      // New agent processes, SAME session keys -> same seats (already
      // seated; connect() only, a join would be ALREADY_SEATED).
      reconnected.push(new PlayerAgent({
        tableUrl: `ws://127.0.0.1:${server.port}`,
        fnnUrl: PLAYER_URL!,
        fnnToken: PLAYER_TOKEN!,
        currency: "Fibt",
        sessionKeyPath: `${keyDir}/${name}.session.json`,
        buyInShannons: BUY_IN,
        label: `${name}-2`,
        policy: "call-station",
      }));
    }
    await Promise.all(reconnected.map((a) => a.connect()));
    const handOver = reconnected[0].waitFor("HAND_RESULT", 240_000).catch(() => null);
    for (const a of reconnected) void a.playLoop(40).catch(() => undefined);
    expect(await handOver).not.toBeNull();

    // Dual cash-out on the recovered table: payouts, then ONE close.
    await Promise.all(reconnected.map((a) => a.leave()));
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
  }, 900_000);
});

function writeAgentKey(dir: string, name: string, kp: { privateKey: string; publicKey: string }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}.session.json`, JSON.stringify(kp), { mode: 0o600 });
}
