/**
 * Six-player scripted table demo (docs/09 section 6 as a demo):
 * six players join, hands play with shoves and side pots, one player leaves
 * mid-session and a replacement joins. Spawn its own server on :8091.
 *
 *   npm run demo:six
 */

import { generateKeyPair } from "@fiber-poker/protocol";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { FakeSettlementAdapter } from "@fiber-poker/settlement";
import { TestClient } from "../helpers/client.ts";

const K = 100_000_000n;

async function main(): Promise<void> {
  const server = new TableServer(
    { port: 8091, dataDir: ".data/demo-six", turnTimeoutMs: 4000 },
    { adapter: new FakeSettlementAdapter(), events: new InMemoryEventStore(), snapshots: new InMemorySnapshotStore(), keys: generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n))) },
  );
  await server.start();
  console.log(`[demo:six] server on ws://127.0.0.1:${server.port} (fake settlement, devnet play value only)`);

  // Seat the first two players, start the bots, then let the rest queue —
  // this way every watched hand has live bot play.
  const players: TestClient[] = [];
  for (let i = 0; i < 2; i++) {
    const c = new TestClient(generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n))), `p${i}`);
    await c.connect(`ws://127.0.0.1:${server.port}`);
    await c.joinTable(100n * K);
    players.push(c);
    console.log(`[demo:six] p${i} seated`);
  }

  // Background bots: aggressive enough to build side pots.
  let stop = false;
  const bot = async (c: TestClient): Promise<void> => {
    while (!stop) {
      try {
        const expected = (c as unknown as { sequence: bigint }).sequence + 1n;
        const got = await c
          .waitFor("YOUR_TURN", 400, (m) => {
            const seq = (m.payload as { sequence?: string }).sequence;
            return seq !== undefined && BigInt(seq) >= expected;
          })
          .then(() => true)
          .catch(() => false);
        if (!got) continue;
        const legal = ((c.yourTurn as { legal?: { actions: string[] } }).legal?.actions ?? []) as string[];
        const maxTo = (c.yourTurn as { legal?: { maxRaiseTo?: string } }).legal?.maxRaiseTo;
        const callAmount = BigInt(((c.yourTurn as { legal?: { callAmount?: string } }).legal?.callAmount ?? "0"));
        const cheap = callAmount <= 2n * K;
        const action = legal.includes("RAISE") && maxTo !== undefined && Math.random() < 0.3
          ? { type: "RAISE", amount: BigInt(maxTo) }
          : legal.includes("CHECK")
            ? { type: "CHECK" }
            : legal.includes("CALL") && cheap
              ? { type: "CALL" }
              : { type: "FOLD" };
        if (process.env.DEMO_VERBOSE) console.log(`[demo:six] t+${Date.now() % 100000} ${c.label} -> ${action.type}`);
        // Fire-and-retry: with concurrent timeout folds the chain may move
        // between our snapshot and the act; stale attempts just retry.
        await c.actRaw(action as { type: string }, { nonce: `n-${Math.random().toString(16).slice(2)}` });
      } catch (e) {
        console.log(`[demo:six] ${c.label} bot error:`, String(e));
        return;
      }
    }
  };
  players.forEach((c) => void bot(c));

  for (let i = 2; i < 6; i++) {
    const c = new TestClient(generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n))), `p${i}`);
    await c.connect(`ws://127.0.0.1:${server.port}`);
    await c.joinTable(100n * K);
    players.push(c);
    console.log(`[demo:six] p${i} seated (joins queue until the live hand ends)`);
  }
  players.slice(2).forEach((c) => void bot(c));

  // Watch 4 hands.
  let multiPotSeen = false;
  for (let h = 0; h < 4; h++) {
    const result = await players[0]!.waitFor("HAND_RESULT", 90_000).catch(() => null);
    console.log(`[demo:six] t+${Date.now() % 100000} hand ${h + 1} result`);
    if (!result) break;
    const p = result.payload as { pots: { amount: string }[]; awards: { playerId: string; amount: string }[]; showdowns: unknown[] };
    if (p.pots.length >= 2) multiPotSeen = true;
    console.log(
      `[demo:six] hand ${h + 1}: pots=${p.pots.map((x) => Number(BigInt(x.amount) / K) + "CKB").join("+")}` +
        ` awards=${p.awards.map((a) => a.playerId.slice(0, 6) + "…+" + Number(BigInt(a.amount) / K)).join(",")}` +
        ` showdowns=${p.showdowns.length}`,
    );
  }
  console.log(`[demo:six] multi-pot hand observed: ${multiPotSeen ? "yes" : "no (timing-dependent)"}`);

  // Leave + join.
  console.log("[demo:six] p5 requests leave (processed at hand end)…");
  await players[5]!.leave();
  const fresh = new TestClient(generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n))), "newbie");
  await fresh.connect(`ws://127.0.0.1:${server.port}`);
  await fresh.joinTable(100n * K);
  console.log(`[demo:six] newcomer seated; seats now: ${server.seatRecords().length}`);

  stop = true;
  for (const c of [...players, fresh]) c.close();
  await server.stop();
  console.log("[demo:six] channels closed, server stopped — devnet/testnet play value only");
  process.exit(0);
}

main().catch((e) => {
  console.error("[demo:six] fatal:", e);
  process.exit(1);
});
