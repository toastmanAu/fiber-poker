/**
 * Two-player scripted table demo.
 *
 *   npm run demo:two                        # spawns its own server on :8090
 *   npm run demo:two -- -- --url ws://127.0.0.1:8080   # joins a running server
 *
 * Runs a few hands with visible commentary. Fake settlement (dev only).
 */

import { generateKeyPair } from "@fiber-poker/protocol";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { FakeSettlementAdapter } from "@fiber-poker/settlement";
import { TestClient } from "../helpers/client.ts";

const K = 100_000_000n;

function argUrl(): string | null {
  const i = process.argv.indexOf("--url");
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main(): Promise<void> {
  let server: TableServer | null = null;
  let url = argUrl();
  if (!url) {
    server = new TableServer(
      { port: 8090, dataDir: ".data/demo-two", turnTimeoutMs: 5000 },
      { adapter: new FakeSettlementAdapter(), events: new InMemoryEventStore(), snapshots: new InMemorySnapshotStore(), keys: generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n))) },
    );
    await server.start();
    url = `ws://127.0.0.1:${server.port}`;
    console.log(`[demo] server on ${url} (fake settlement, devnet play value only)`);
  }

  const mk = (label: string): TestClient =>
    new TestClient(generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n))), label);

  const alice = mk("alice");
  const bob = mk("bob");
  await alice.connect(url);
  await bob.connect(url);
  console.log("[demo] players authenticated");

  await alice.joinTable(100n * K);
  await bob.joinTable(100n * K);
  console.log("[demo] both seated with 100 CKB buy-ins");

  if (server) {
    // Auto-start hands is on for the spawned server; manual for joined ones.
  } else {
    console.log("[demo] waiting for the table's next hand…");
  }

  // Bots: check/call/fold sensibly until 3 hands complete.
  const hands = 3;
  for (let h = 0; h < hands; h++) {
    await alice.waitFor("HAND_START", 60_000).catch(() => undefined);
    console.log(`[demo] hand ${h + 1} started`);
    const done = alice.waitFor("HAND_RESULT", 60_000).catch(() => null);
    const bot = async (c: TestClient): Promise<void> => {
      for (;;) {
        const settled = await Promise.race([
          done.then(() => true).catch(() => false),
          new Promise<boolean>((r) => setTimeout(() => r(false), 250)),
        ]);
        if (settled) return;
        const expected = (c as unknown as { sequence: bigint }).sequence + 1n;
        const got = await c
          .waitFor("YOUR_TURN", 350, (m) => {
            const seq = (m.payload as { sequence?: string }).sequence;
            return seq !== undefined && BigInt(seq) >= expected;
          })
          .then(() => true)
          .catch(() => false);
        if (!got) continue;
        const legal = ((c.yourTurn as { legal?: { actions: string[] } }).legal?.actions ?? []) as string[];
        const act = legal.includes("CHECK") ? { type: "CHECK" } : legal.includes("CALL") ? { type: "CALL" } : { type: "FOLD" };
        await c.act(act);
      }
    };
    await Promise.all([bot(alice), bot(bob)]);
    const result = await done;
    const awards = (result?.payload as { awards?: { playerId: string; amount: string }[] })?.awards ?? [];
    console.log(`[demo] hand ${h + 1} complete:`, awards.map((a) => `${a.playerId.slice(0, 8)}… +${Number(BigInt(a.amount) / K)} CKB`).join(", "));
  }

  const stacks = alice.seatsFromLastCommit().map((s) => `${s.playerId?.slice(0, 8)}…=${Number(BigInt(s.stack) / K)} CKB`);
  console.log("[demo] final stacks:", stacks.join(", "));
  console.log("[demo] done — devnet/testnet play value only, not a real-money service");

  alice.close();
  bob.close();
  if (server) await server.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error("[demo] fatal:", e);
  process.exit(1);
});
