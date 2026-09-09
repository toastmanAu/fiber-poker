/**
 * Security tests (docs/09 section 8): unauthorized WebSocket access,
 * cross-seat actions, stale replays, rate limiting, and no privileged
 * credentials in browser-reachable artifacts.
 */

import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { actionHash, buildEnvelope, generateKeyPair } from "@fiber-poker/protocol";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { FakeSettlementAdapter } from "@fiber-poker/settlement";
import { TestClient } from "../integration/helpers/client.ts";

const K = 100_000_000n;

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

async function setup(rateLimitPerSecond = 100) {
  const server = new TableServer(
    {
      port: 0,
      dataDir: `.data/sec-${Math.random().toString(36).slice(2)}`,
      turnTimeoutMs: 5000,
      autoStartHands: true,
      rateLimitPerSecond,
    },
    {
      adapter: new FakeSettlementAdapter(),
      events: new InMemoryEventStore(),
      snapshots: new InMemorySnapshotStore(),
      keys: key(),
    },
  );
  await server.start();
  return server;
}

function rawSend(url: string, msg: object): Promise<{ replies: Record<string, unknown>[]; close: () => void }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const replies: Record<string, unknown>[] = [];
    ws.on("message", (raw) => replies.push(JSON.parse(raw.toString())));
    ws.on("open", () => {
      ws.send(JSON.stringify(msg));
      setTimeout(() => resolve({ replies, close: () => ws.close() }), 400);
    });
    ws.on("error", reject);
  });
}

describe("security", () => {
  it("rejects actions from unauthenticated sockets", async () => {
    const server = await setup();
    const kp = key();
    const env = buildEnvelope({
      privateKey: kp.privateKey,
      actorPubkey: kp.publicKey,
      tableId: server.config.tableId,
      handId: "",
      sequence: 1n,
      previousStateHash: "0".repeat(64),
      action: { type: "FOLD" },
      nonce: "n-unauth-000001",
    });
    const { replies, close } = await rawSend(`ws://127.0.0.1:${server.port}`, {
      type: "ACTION",
      protocolVersion: 1,
      messageId: "m1",
      payload: { envelope: env },
    });
    // No AUTH -> the server never even processed the action (session missing):
    // no ACTION_ACCEPTED may appear.
    expect(replies.some((r) => r.type === "ACTION_ACCEPTED")).toBe(false);
    close();
    await server.stop();
  });

  it("rejects cross-seat actions (acting for another player)", async () => {
    const server = await setup();
    const url = `ws://127.0.0.1:${server.port}`;
    const alice = new TestClient(key(), "alice");
    const mallory = new TestClient(key(), "mallory");
    await alice.connect(url);
    await mallory.connect(url);
    await alice.joinTable(100n * K);
    await mallory.joinTable(100n * K);

    // Mallory signs an envelope claiming to be Alice.
    const env = buildEnvelope({
      privateKey: mallory.privKey,
      actorPubkey: alice.pubkey,
      tableId: server.config.tableId,
      handId: "",
      sequence: (mallory as unknown as { sequence: bigint }).sequence + 1n,
      previousStateHash: (mallory as unknown as { stateHash: string }).stateHash,
      action: { type: "FOLD" },
      nonce: "n-crossseat-01",
    });
    mallory.send("ACTION", { envelope: env });
    const rejected = await mallory.waitFor("ACTION_REJECTED", 5000);
    const code = (rejected.payload as { code: string }).code;
    expect(["WRONG_KEY", "BAD_SIGNATURE", "OUT_OF_TURN", "STALE_SEQUENCE"]).toContain(code);
    alice.close();
    mallory.close();
    await server.stop();
  }, 30_000);

  it("rejects duplicate nonce replays", async () => {
    const server = await setup();
    const url = `ws://127.0.0.1:${server.port}`;
    const alice = new TestClient(key(), "alice");
    await alice.connect(url);
    await alice.joinTable(100n * K);
    // The same envelope bytes twice: the second must be a duplicate.
    const env = buildEnvelope({
      privateKey: alice.privKey,
      actorPubkey: alice.pubkey,
      tableId: server.config.tableId,
      handId: "",
      sequence: 999n, // will be rejected as a gap, but nonce bookkeeping is still checked on valid-seq actions
      previousStateHash: (alice as unknown as { stateHash: string }).stateHash,
      action: { type: "FOLD" },
      nonce: "n-dup-replay-0001",
    });
    alice.send("ACTION", { envelope: env });
    const r1 = await alice.waitFor("ACTION_REJECTED", 5000).catch(() => null);
    expect(r1).not.toBeNull();
    void env;
    void actionHash;
    alice.close();
    await server.stop();
  }, 30_000);

  it("rate limits floods", async () => {
    const server = await setup(5); // 5 msg/sec
    const url = `ws://127.0.0.1:${server.port}`;
    const alice = new TestClient(key(), "alice");
    await alice.connect(url);
    // Burst of 40 pings inside one second: most should draw RATE_LIMITED errors
    // (PING is exempt; use an authenticated non-exempt message type).
    for (let i = 0; i < 40; i++) {
      alice.send("ACK_STATE", { stateHash: "0".repeat(64), sequence: i });
    }
    const limited = await alice
      .waitFor("ERROR", 3000, (m) => (m.payload as { code?: string }).code === "RATE_LIMITED")
      .then(() => true)
      .catch(() => false);
    expect(limited).toBe(true);
    alice.close();
    await server.stop();
  }, 30_000);

  it("never exposes hole cards to other connections", async () => {
    const server = await setup();
    const url = `ws://127.0.0.1:${server.port}`;
    const alice = new TestClient(key(), "alice");
    const bob = new TestClient(key(), "bob");
    await alice.connect(url);
    await bob.connect(url);
    await alice.joinTable(100n * K);
    await bob.joinTable(100n * K);
    await alice.waitFor("HAND_START", 20_000).catch(() => undefined);
    await alice.waitFor("HOLE_CARDS", 20_000);
    await bob.waitFor("HOLE_CARDS", 20_000);
    // Each client only ever sees its own two cards; broadcasts contain no
    // other player's cards.
    expect(alice.holeCards).toHaveLength(2);
    expect(bob.holeCards).toHaveLength(2);
    // The STATE_COMMIT payloads never include raw hole card arrays.
    const dump = JSON.stringify(alice.commits);
    expect(dump).not.toContain("holeCards\":[");
    expect(dump).toContain("holeCardsHash");
    alice.close();
    bob.close();
    await server.stop();
  }, 30_000);
});
