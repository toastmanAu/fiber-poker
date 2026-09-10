/**
 * LIVE 2-player hand over a real Fiber node pair (gated).
 *
 *   FIBER_POKER_FNN_URL=http://192.168.68.80:8227 \          # table node
 *   FIBER_POKER_FNN_TOKEN=<table biscuit> \
 *   FIBER_POKER_PLAYER_FNN_URL=http://192.168.68.102:8231 \   # player node
 *   FIBER_POKER_PLAYER_FNN_TOKEN=<player biscuit> \
 *   npx vitest run tests/fiber/live-hand.test.ts
 *
 * Full stack: WS table server in FIBER settlement mode, two poker seats
 * (peer-mapped onto the player node per docs/15), real invoice payments for
 * buy-in/blinds/bets, real keysend payout to the winner. Small amounts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { RealFiberGateway } from "@fiber-poker/fiber-adapter";
import { ImmediateFiberSettlement } from "@fiber-poker/settlement";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { TestClient } from "../integration/helpers/client.ts";

const TABLE_URL = process.env.FIBER_POKER_FNN_URL;
const TABLE_TOKEN = process.env.FIBER_POKER_FNN_TOKEN;
const PLAYER_URL = process.env.FIBER_POKER_PLAYER_FNN_URL ?? TABLE_URL;
const PLAYER_TOKEN = process.env.FIBER_POKER_PLAYER_FNN_TOKEN ?? TABLE_TOKEN;

const GATED = Boolean(TABLE_URL && TABLE_TOKEN && PLAYER_URL && PLAYER_TOKEN);
const d = GATED ? describe : describe.skip;

const K = 100_000_000n;
const BUY_IN = 10n * K;

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

d("live 2-player hand (real fiber settlements)", () => {
  let server: TableServer;
  let adapter: ImmediateFiberSettlement;
  const clients: TestClient[] = [];

  afterAll(async () => {
    for (const c of clients) c.close();
    await server?.stop().catch(() => undefined);
  });

  it("plays a full hand with real invoice payments and a real payout", async () => {
    // docs/15: player fiber node (driveThree) backs both poker seats. The
    // peer map must key on the ACTUAL poker session pubkeys.
    const aliceKp = key();
    const bobKp = key();
    const tableGateway = new RealFiberGateway({ url: TABLE_URL!, authToken: TABLE_TOKEN, currency: "Fibt" });
    const playerGateway = new RealFiberGateway({ url: PLAYER_URL!, authToken: PLAYER_TOKEN, currency: "Fibt" });
    const playerPubkey = await playerGateway.nodePubkey();

    adapter = new ImmediateFiberSettlement(tableGateway, {
      pollMs: 250,
      timeoutMs: 60_000,
      resolvePeer: (playerId) => (playerId === aliceKp.publicKey || playerId === bobKp.publicKey ? playerPubkey : playerId),
    });

    server = new TableServer(
      {
        port: 0,
        dataDir: `.data/live-hand-${Math.random().toString(36).slice(2)}`,
        turnTimeoutMs: 30_000,
        peerMapJson: JSON.stringify({ [aliceKp.publicKey]: playerPubkey, [bobKp.publicKey]: playerPubkey }),
      },
      {
        gateway: tableGateway,
        adapter,
        events: new InMemoryEventStore(),
        snapshots: new InMemorySnapshotStore(),
        keys: key(),
      },
    );
    await server.start();

    // Auto-pay agent: the player's fiber node pays every invoice request.
    adapter.onPaymentRequest((req) => {
      if (req.obligation.direction !== "PLAYER_TO_TABLE" || !req.invoiceAddress) return;
      playerGateway.payInvoice(req.invoiceAddress).then(
        (r) => console.log(`[live-hand] paid: ${r.paymentHash.slice(0, 16)}…`),
        (e) => console.log(`[live-hand] PAY FAILED: ${String(e)}`),
      );
    });

    const alice = new TestClient(aliceKp, "alice");
    const bob = new TestClient(bobKp, "bob");
    clients.push(alice, bob);
    await alice.connect(`ws://127.0.0.1:${server.port}`);
    await bob.connect(`ws://127.0.0.1:${server.port}`);
    await alice.joinTable(BUY_IN);
    await bob.joinTable(BUY_IN);
    expect(server.seatRecords()).toHaveLength(2);

    // The hand auto-starts; blinds settle as real invoices.
    await alice.waitFor("HAND_START", 60_000);
    await alice.waitFor("HOLE_CARDS", 60_000);
    await bob.waitFor("HOLE_CARDS", 60_000);

    // Play it out: fold on turn until the hand ends.
    const resultP = alice.waitFor("HAND_RESULT", 90_000).catch(() => null);
    for (let i = 0; i < 8; i++) {
      for (const c of [alice, bob]) {
        const got = await c.waitFor("YOUR_TURN", 5000).then(() => true).catch(() => false);
        if (!got) continue;
        const legal = ((c.yourTurn as { legal?: { actions: string[] } }).legal?.actions ?? []) as string[];
        const act = legal.includes("CHECK") ? { type: "CHECK" } : legal.includes("CALL") ? { type: "CALL" } : { type: "FOLD" };
        await c.act(act);
      }
    }
    const result = await resultP;
    expect(result).not.toBeNull();
    const awards = (result!.payload as { awards: { playerId: string; amount: string }[] }).awards;
    expect(awards.length).toBeGreaterThanOrEqual(1);

    // Poker conservation at ANY phase: stacks + committed chips == buy-ins
    // (committed chips may be mid-settlement in pots or already awarded).
    const seats = server.runtime.state.seats.filter((s) => s.playerId);
    const conserved = seats.reduce((a, s) => a + s.stack + s.handContribution, 0n);
    expect(conserved).toBe(2n * BUY_IN);

    alice.close();
    bob.close();
  }, 180_000);
});


