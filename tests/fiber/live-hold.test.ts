/**
 * LIVE hold-mode session (gated) — P1/P9: HoldInvoiceSettlement against the
 * real fnn rc7 nodes.
 *
 * TRUE rc7 hold recipe (live-verified 2026-09-11, see docs/fnn-compat.md):
 * the table creates each bet invoice from payment_hash ONLY (CKB blake2b-256
 * of its own preimage); the agent pays it; the invoice parks at `Received` —
 * funds LOCKED, not final — and the action commits on HELD. At hand end the
 * table settles every held invoice by revealing the preimage
 * (settle_invoice). Buy-ins/top-ups are not hand-refundable, so the
 * coordinator settles their holds immediately (event status HELD+FINALIZED).
 *
 *   FIBER_POKER_FNN_URL=http://192.168.68.80:8227 \
 *   FIBER_POKER_FNN_TOKEN=<table biscuit> \
 *   FIBER_POKER_PLAYER_FNN_URL=http://192.168.68.102:8231 \
 *   FIBER_POKER_PLAYER_FNN_TOKEN=<player biscuit> \
 *   npx vitest run tests/fiber/live-hold.test.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { RealFiberGateway } from "@fiber-poker/fiber-adapter";
import { HoldInvoiceSettlement } from "@fiber-poker/settlement";
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
const HANDS = 2;

function key() {
  return generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
}

d("live hold-mode session (hold-at-bet, settle-at-hand-end on rc7)", () => {
  let server: TableServer;
  let holdAdapter: HoldInvoiceSettlement;
  let events: InMemoryEventStore;
  const agents: PlayerAgent[] = [];

  afterAll(async () => {
    await server?.stop().catch(() => undefined);
  });

  it("commits bets on HELD invoices, settles them at hand end, and pays out both seats", async () => {
    const tableGateway = new RealFiberGateway({ url: TABLE_URL!, authToken: TABLE_TOKEN!, currency: "Fibt" });
    const playerGateway = new RealFiberGateway({ url: PLAYER_URL!, authToken: PLAYER_TOKEN!, currency: "Fibt" });
    const playerPeer = await playerGateway.nodePubkey();

    const peerMapJson: Record<string, string> = {};
    const keyDir = `.data/live-hold-${Math.random().toString(36).slice(2)}`;
    mkdirSync(keyDir, { recursive: true });
    const agentSpecs = (["hold-alice", "hold-bob"] as const).map((name) => {
      const kp = key();
      const keyPath = `${keyDir}/${name}.session.json`;
      writeFileSync(keyPath, JSON.stringify(kp), { mode: 0o600 });
      peerMapJson[kp.publicKey] = playerPeer;
      return { name, keyPath };
    });

    holdAdapter = new HoldInvoiceSettlement(tableGateway, { pollMs: 250 });
    events = new InMemoryEventStore();

    server = new TableServer(
      {
        port: 0,
        dataDir: `.data/live-hold-${Math.random().toString(36).slice(2)}`,
        turnTimeoutMs: 30_000,
        peerMapJson: JSON.stringify(peerMapJson),
      },
      {
        gateway: tableGateway,
        adapter: holdAdapter,
        events,
        snapshots: new InMemorySnapshotStore(),
        keys: key(),
      },
    );
    await server.start();
    expect(server.coordinator.holdMode).toBe(true);

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

    const dumpDiagnostics = (tag: string) => {
      console.log(`[diagnostics:${tag}] phase=${server.runtime.state.phase} handNo=${server.runtime.state.handNo} seats=${server.seatRecords().length}`);
      for (const e of holdAdapter.allEntries()) console.log(`[diagnostics:${tag}]`, JSON.stringify(e));
      for (const ev of events.events.filter((e) => e.eventType === "PaymentFailed")) {
        console.log(`[diagnostics:${tag}] PaymentFailed`, JSON.stringify(ev.payload));
      }
    };

    try {
      await runSession();
    } catch (err) {
      dumpDiagnostics("failure");
      throw err;
    }

    async function runSession() {
      await Promise.all(agents.map((a) => a.join()));
      expect(server.seatRecords()).toHaveLength(2);

      // Buy-ins are not hand-refundable: their holds must have been settled
      // immediately (event status HELD+FINALIZED), never left at Received.
      const finalizedBuyIns = events.events.filter(
        (e) => e.eventType === "PaymentSucceeded" && (e.payload as { status?: string }).status === "HELD+FINALIZED",
      );
      expect(finalizedBuyIns.length).toBe(2);

      for (const a of agents) void a.playLoop(120).catch(() => undefined);

      const seenHandIds = new Set<string>();
      while (seenHandIds.size < HANDS) {
        const result = await agents[0].waitFor("HAND_RESULT", 300_000, (m) => {
          const id = (m.payload as { handId?: string }).handId ?? "";
          return id !== "" && !seenHandIds.has(id);
        });
        seenHandIds.add((result.payload as { handId: string }).handId);
      }
      expect(server.runtime.state.handNo).toBeGreaterThanOrEqual(HANDS);

      // Bets genuinely committed on HOLDS, not auto-settled payments: the
      // hand-scoped obligations must show the HELD commit marker.
      const heldCommits = events.events.filter(
        (e) => e.eventType === "PaymentSucceeded" && (e.payload as { status?: string }).status === "HELD",
      );
      expect(heldCommits.length).toBeGreaterThanOrEqual(4); // blinds for 2 hands
      // (Both hands completing is itself the finalize proof: a finalize
      // failure fail-stops the table and no further HAND_RESULT arrives.
      // Do NOT assert the phase here — hands auto-restart and the next one
      // is already live by the time the last HAND_RESULT is observed.)

      // Conservation after two hands.
      const seated = server.runtime.state.seats.filter((s) => s.playerId);
      expect(seated.reduce((a, s) => a + s.stack + s.handContribution, 0n)).toBe(2n * BUY_IN);

      // Dual cash-out: payouts are immediate keysends in hold mode; the
      // shared channel closes once after the last seat leaves.
      const sharedChannelId = server.channels.channelId(agents[0].pubkey)!;
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
