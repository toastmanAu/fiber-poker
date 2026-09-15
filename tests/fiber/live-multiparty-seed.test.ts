/**
 * LIVE multiparty-seed deal (gated) — P10's commit/reveal deck protocol
 * against the real nodes: the table collects per-player secret seeds over
 * the wire, deals the hand from the combined seed, and reveals for audit —
 * with every buy-in, blind, and bet settled for real through the players'
 * fiber node.
 *
 * The TestClients speak the seed protocol natively (auto commit/reveal);
 * their invoices are settled by a server-side hook through the REAL player
 * node (the same node both seats declare).
 *
 *   FIBER_POKER_FNN_URL=http://192.168.68.80:8227 \
 *   FIBER_POKER_FNN_TOKEN=<table biscuit> \
 *   FIBER_POKER_PLAYER_FNN_URL=http://192.168.68.102:8231 \
 *   FIBER_POKER_PLAYER_FNN_TOKEN=<player biscuit> \
 *   npx vitest run tests/fiber/live-multiparty-seed.test.ts
 */

import { afterAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { RealFiberGateway } from "@fiber-poker/fiber-adapter";
import { ImmediateFiberSettlement } from "@fiber-poker/settlement";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { TestClient } from "../integration/helpers/client.ts";
import { ensureSessionCapacity } from "./helpers/live-topology.ts";

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

d("live multiparty-seed deal (commit/reveal deck on real nodes)", () => {
  let server: TableServer;
  const clients: TestClient[] = [];

  afterAll(async () => {
    for (const c of clients) c.close();
    await server?.stop().catch(() => undefined);
  });

  it("collects real seed commitments, deals a hand, settles it, and cashes out", async () => {
    const tableGateway = new RealFiberGateway({ url: TABLE_URL!, authToken: TABLE_TOKEN!, currency: "Fibt" });
    const playerGateway = new RealFiberGateway({ url: PLAYER_URL!, authToken: PLAYER_TOKEN!, currency: "Fibt" });
    const playerPeer = await playerGateway.nodePubkey();

    await ensureSessionCapacity(tableGateway, playerGateway, {
      minPlayerSide: 3n * BUY_IN,
      minTableSide: 3n * BUY_IN,
      openFunding: 600n * K,
    });

    const aliceKey = key();
    const bobKey = key();
    const events = new InMemoryEventStore();
    const adapter = new ImmediateFiberSettlement(tableGateway, {
      pollMs: 250,
      timeoutMs: 60_000,
      resolvePeer: () => playerPeer,
    });
    // Server-side payer through the REAL player node (TestClients hold no
    // fiber credentials — the node does the paying for both seats).
    adapter.onPaymentRequest((req) => {
      if (req.obligation.direction === "PLAYER_TO_TABLE" && req.invoiceAddress) {
        void playerGateway.payInvoice(req.invoiceAddress).catch(() => undefined);
      }
    });

    server = new TableServer(
      {
        port: 0,
        dataDir: `.data/live-seed-${Math.random().toString(36).slice(2)}`,
        autoStartHands: false,
        turnTimeoutMs: 60_000,
        deck: "multiparty-seed",
        seedTimeoutMs: 30_000,
        peerMapJson: JSON.stringify({ [aliceKey.publicKey]: playerPeer, [bobKey.publicKey]: playerPeer }),
      },
      {
        gateway: tableGateway,
        adapter,
        events,
        snapshots: new InMemorySnapshotStore(),
        keys: key(),
      },
    );
    await server.start();

    for (const [name, kp] of [
      ["alice", aliceKey],
      ["bob", bobKey],
    ] as const) {
      const client = new TestClient(kp, name);
      clients.push(client);
      await client.connect(`ws://127.0.0.1:${server.port}`);
      await client.joinTable(BUY_IN);
    }
    expect(server.seatRecords()).toHaveLength(2);

    // The seed protocol runs over the wire to BOTH real clients.
    await (server as unknown as { maybeStartHand: () => Promise<void> }).maybeStartHand();
    await clients[0].waitFor("HAND_START", 120_000);
    await clients[0].waitFor("HOLE_CARDS", 120_000);
    await clients[1].waitFor("HOLE_CARDS", 120_000);
    expect(clients[0].holeCards).toHaveLength(2);
    expect(clients[1].holeCards).toHaveLength(2);

    // Durable evidence the seed protocol ran (Started; Completed is only
    // appended when a non-revealer is sat out, which honest clients avoid).
    const types = (await events.readAll()).map((e) => e.eventType);
    expect(types).toContain("SeedProtocolStarted");

    // Play the hand out with real settlements (check/call policy).
    const done = clients[0].waitFor("HAND_RESULT", 300_000).catch(() => null);
    for (let i = 0; i < 24; i++) {
      const phase = server.runtime.state.phase;
      if (!["PREFLOP", "FLOP", "TURN", "RIVER"].includes(phase)) break;
      const seat = server.runtime.state.actingSeat;
      const actor = server.runtime.state.seats[seat!]!.playerId === clients[0].pubkey ? clients[0] : clients[1];
      const turn = await actor.waitFor("YOUR_TURN", 30_000).catch(() => null);
      if (!turn) break;
      const legal = (turn.payload as { legal: { actions: string[] } }).legal.actions;
      await actor.act(legal.includes("CHECK") ? { type: "CHECK" } : { type: "CALL" });
    }
    expect(await done).not.toBeNull();
    // P10 audit: the multiparty deck reveal lets anyone re-derive the deck
    // from the committed seeds.
    await clients[0].waitFor("DECK_REVEALED", 60_000);

    // Conservation on the live table.
    const seated = server.runtime.state.seats.filter((s) => s.playerId);
    expect(seated.reduce((a, s) => a + s.stack + s.handContribution, 0n)).toBe(2n * BUY_IN);

    // Both seats cash out; payouts are real keyswends.
    await Promise.all(clients.map((c) => c.leave()));
    expect(server.seatRecords()).toHaveLength(0);
  }, 600_000);
});
