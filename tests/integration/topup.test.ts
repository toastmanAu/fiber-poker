/**
 * TOP_UP message edge cases over the real WS protocol (fake settlement):
 * rejections for unauthenticated/unseated/bad amounts, and the conservation
 * effect of an accepted top-up on the committed engine state.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { TestClient } from "./helpers/client.ts";
import { K, startTestServer } from "./helpers/server.ts";

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

describe("top-up requests", () => {
  const serverBox: { server?: Awaited<ReturnType<typeof startTestServer>>["server"]; url: string } = { url: "" };
  const clients: TestClient[] = [];

  beforeAll(async () => {
    const started = await startTestServer({ turnTimeoutMs: 1500 });
    serverBox.server = started.server;
    serverBox.url = started.url;
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await serverBox.server?.stop();
  });

  it("rejects top-ups from connected but unseated clients", async () => {
    const stranger = new TestClient(key(), "stranger");
    clients.push(stranger);
    await stranger.connect(serverBox.url); // authenticated, never joined
    stranger.sendRaw("TOP_UP", { amountShannons: (5n * K).toString() });
    const err = await stranger.waitFor("ERROR", 5_000);
    expect((err.payload as { code: string }).code).toBe("NOT_SEATED");
  });

  it("rejects non-positive amounts and accepts a valid top-up between hands", async () => {
    const server = serverBox.server!;
    const alice = new TestClient(key(), "alice");
    const bob = new TestClient(key(), "bob");
    clients.push(alice, bob);
    await alice.connect(serverBox.url);
    await bob.connect(serverBox.url);
    await alice.joinTable(100n * K);
    await bob.joinTable(100n * K);

    // Zero / negative amounts are refused (server-side amount guard).
    alice.sendRaw("TOP_UP", { amountShannons: "0" });
    const err = await alice.waitFor("ERROR", 5_000);
    expect((err.payload as { code: string }).code).toBe("INVALID_AMOUNT");

    // Play one hand out so the table is between hands.
    for (const client of [alice, bob]) {
      try {
        const turnMsg = await client.waitFor("YOUR_TURN", 10_000);
        const legal = (turnMsg.payload as { legal: { actions: string[] } }).legal.actions;
        await client.act(legal.includes("FOLD") && !legal.includes("CHECK") ? { type: "FOLD" } : { type: "CHECK" });
      } catch {
        /* no turn this hand */
      }
    }
    await alice.waitFor("HAND_RESULT", 20_000);
    // Wait out the settlement → HAND_COMPLETE so the top-up applies directly.
    await alice.waitFor("DECK_REVEALED", 20_000).catch(() => undefined);

    const totalBefore = () =>
      server.runtime.state.seats
        .filter((s) => s.playerId)
        .reduce((a, s) => a + s.stack + s.handContribution, 0n);
    // A blind may land mid-assertion (hands auto-restart); the conservation
    // TOTAL is timing-proof where raw stack deltas are not.
    const before = totalBefore();
    alice.sendRaw("TOP_UP", { amountShannons: (25n * K).toString() });
    await alice.waitFor("TOP_UP_APPLIED", 10_000, (m) => true);
    expect(totalBefore() - before).toBe(25n * K);
    expect(totalBefore()).toBe(200n * K + 25n * K);
  }, 60_000);
});
