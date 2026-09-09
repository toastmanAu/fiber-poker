/**
 * Smoke/integration: two players join, hands play out automatically via
 * scripted actions, deck reveal happens, and the hash chain is verifiable
 * end to end through the real WebSocket protocol.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { TestClient } from "./helpers/client.ts";
import { K, startTestServer } from "./helpers/server.ts";

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

describe("two-player table integration", () => {
  const serverBox: { server?: Awaited<ReturnType<typeof startTestServer>>["server"]; adapter?: Awaited<ReturnType<typeof startTestServer>>["adapter"]; url: string } = { url: "" };
  const clients: TestClient[] = [];

  beforeAll(async () => {
    const started = await startTestServer({ turnTimeoutMs: 1500 });
    serverBox.server = started.server;
    serverBox.adapter = started.adapter;
    serverBox.url = started.url;
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await serverBox.server?.stop();
  });

  it("seats two players and starts a hand with hole cards", async () => {
    const { server, url } = serverBox as { server: NonNullable<typeof serverBox.server>; url: string };
    const alice = new TestClient(key(), "alice");
    const bob = new TestClient(key(), "bob");
    clients.push(alice, bob);
    await alice.connect(url);
    await bob.connect(url);
    await alice.joinTable(100n * K);
    await bob.joinTable(100n * K);

    // Auto-start: both players receive hole cards for hand 1.
    await alice.waitFor("HAND_START", 20_000);
    await alice.waitFor("HOLE_CARDS", 20_000);
    await bob.waitFor("HOLE_CARDS", 20_000);
    expect(alice.holeCards).toHaveLength(2);
    expect(bob.holeCards).toHaveLength(2);
    expect(server.seatRecords()).toHaveLength(2);
  });

  it("plays hands to completion with payment-before-commit and reveals the deck", async () => {
    const alice = clients[0]!;
    const bob = clients[1]!;

    // Play 3 hands: on your turn, fold half the time / call otherwise.
    for (let hand = 0; hand < 3; hand++) {
      for (const client of [alice, bob]) {
        for (let turn = 0; turn < 6; turn++) {
          try {
            const turnMsg = await client.waitFor("YOUR_TURN", 4000);
            const legal = (turnMsg.payload as { legal: { actions: string[] } }).legal.actions;
            const act = legal.includes("CHECK")
              ? { type: "CHECK" }
              : legal.includes("CALL")
                ? { type: "CALL" }
                : { type: "FOLD" };
            await client.act(act);
          } catch {
            break; // no turn for this client in this hand
          }
        }
      }
      const either = hand % 2 === 0 ? alice : bob;
      await either.waitFor("HAND_RESULT", 20_000);
      await either.waitFor("DECK_REVEALED", 20_000);
    }

    // Chain verification: every commit references the previous hash.
    const commits = alice.commits;
    expect(commits.length).toBeGreaterThan(10);
    let prev = "";
    let started = false;
    for (const c of commits) {
      const p = c.payload as { previousStateHash: string; stateHash: string; actionHash: string };
      if (!started) {
        started = true;
      } else {
        expect(p.previousStateHash, "chain must link").toBe(prev);
      }
      prev = p.stateHash;
    }

    // Conservation at the latest observed chain state: stack + in-hand
    // contributions always sum to total buy-ins (200 CKB), whatever the
    // in-flight hand.
    const seats = alice.seatsFromLastCommit();
    const total = seats
      .filter((s) => s.playerId)
      .reduce((a, s) => a + BigInt(s.stack) + BigInt(s.handContribution as unknown as string), 0n);
    expect(total).toBe(200n * K);
  }, 90_000);

  it("rejects stale/replayed actions", async () => {
    const alice = clients[0]!;
    // A stale sequence (0, while the chain is way past it) must be rejected
    // without any state change.
    const hash = await alice.actRaw({ type: "FOLD" }, { sequence: 0n, nonce: `n-stale-${Date.now()}` });
    const code = await alice.waitForRejected(hash);
    expect(["STALE_SEQUENCE", "SEQUENCE_GAP", "WRONG_PREVIOUS_STATE_HASH"]).toContain(code);
  });
});
