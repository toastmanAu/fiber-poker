/**
 * LIVE companion rehearsal (gated) — P3's final checkbox: the browser UI,
 * the local companion relay, and the player's REAL Fiber node end to end.
 *
 * Same shape as companion.spec.ts (simulated), but every invoice is real:
 *   - alice joins from the BROWSER through the companion (--pay-invoices
 *     semantics: the companion pays her buy-in and bets via the player node),
 *   - bob is the existing headless PlayerAgent paying from the same node,
 *   - a real hand is played from the browser (check/call), the table
 *     commits only after real settlements, and conservation holds.
 *
 * Run with the HANDOFF live env vars plus the webClient webServer:
 *   FIBER_POKER_FNN_URL=http://192.168.68.80:8227 \
 *   FIBER_POKER_FNN_TOKEN=<table biscuit> \
 *   FIBER_POKER_PLAYER_FNN_URL=http://192.168.68.102:8231 \
 *   FIBER_POKER_PLAYER_FNN_TOKEN=<player biscuit> \
 *   npx playwright test -c apps/web-client/playwright.config.ts \
 *     apps/web-client/browser/companion-live.spec.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { RealFiberGateway } from "@fiber-poker/fiber-adapter";
import { ImmediateFiberSettlement } from "@fiber-poker/settlement";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { generateKeyPair } from "@fiber-poker/protocol";
import { PlayerCompanion } from "../../player-agent/src/companion.ts";
import { PlayerAgent } from "../../../apps/player-agent/src/agent.ts";
import { ensureSessionCapacity } from "../../../tests/fiber/helpers/live-topology.ts";

const TABLE_URL = process.env.FIBER_POKER_FNN_URL;
const TABLE_TOKEN = process.env.FIBER_POKER_FNN_TOKEN;
const PLAYER_URL = process.env.FIBER_POKER_PLAYER_FNN_URL;
const PLAYER_TOKEN = process.env.FIBER_POKER_PLAYER_FNN_TOKEN;

const GATED = Boolean(TABLE_URL && TABLE_TOKEN && PLAYER_URL && PLAYER_TOKEN);
const K = 100_000_000n;
const BUY_IN = 10n * K;

test.skip(!GATED, "live companion rehearsal needs FIBER_POKER_* env vars");

test("browser plays a live hand through the companion with real settlements", async ({ page }) => {
  test.setTimeout(600_000);
  const tableGateway = new RealFiberGateway({ url: TABLE_URL!, authToken: TABLE_TOKEN!, currency: "Fibt" });
  const playerGateway = new RealFiberGateway({ url: PLAYER_URL!, authToken: PLAYER_TOKEN!, currency: "Fibt" });
  const playerPeer = await playerGateway.nodePubkey();

  // Both directions of channel capacity (bets AND payouts) before joining.
  await ensureSessionCapacity(tableGateway, playerGateway, {
    minPlayerSide: 3n * BUY_IN,
    minTableSide: 3n * BUY_IN,
    openFunding: 200n * K,
  });

  const alice = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
  const bob = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
  const keyDir = join(".data", `companion-live-${Math.random().toString(36).slice(2)}`);
  mkdirSync(keyDir, { recursive: true });
  const aliceKeyPath = join(keyDir, "alice.session.json");
  const bobKeyPath = join(keyDir, "bob.session.json");
  writeFileSync(aliceKeyPath, JSON.stringify(alice), { mode: 0o600 });
  writeFileSync(bobKeyPath, JSON.stringify(bob), { mode: 0o600 });

  const events = new InMemoryEventStore();
  const adapter = new ImmediateFiberSettlement(tableGateway, {
    pollMs: 250,
    timeoutMs: 60_000,
    resolvePeer: () => playerPeer, // both seats behind the one player node
  });
  const server = new TableServer(
    {
      port: 0,
      autoStartHands: false,
      turnTimeoutMs: 60_000,
      peerMapJson: JSON.stringify({ [bob.publicKey]: playerPeer, [alice.publicKey]: playerPeer }),
    },
    { gateway: tableGateway, adapter, events, snapshots: new InMemorySnapshotStore(), keys: generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n))) },
  );
  await server.start();

  // Alice's companion: REAL player node, pays invoices on her behalf.
  const companion = new PlayerCompanion({
    tableUrl: `ws://127.0.0.1:${server.port}`,
    playerId: alice.publicKey,
    port: 0,
    payInvoices: true,
    gateway: new RealFiberGateway({ url: PLAYER_URL!, authToken: PLAYER_TOKEN!, currency: "Fibt" }),
    allowedOrigins: ["http://127.0.0.1:5175"],
  });
  await companion.start();

  // Bob: the headless agent, paying from the same player node.
  const bot = new PlayerAgent({
    tableUrl: `ws://127.0.0.1:${server.port}`,
    fnnUrl: PLAYER_URL!,
    fnnToken: PLAYER_TOKEN!,
    currency: "Fibt",
    sessionKeyPath: bobKeyPath,
    buyInShannons: BUY_IN,
    label: "bob-live-bot",
    policy: "call-station",
  });

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await bot.join();
    expect(server.seatRecords()).toHaveLength(1);
    // Heads-up, bob is the button/SB and acts FIRST — he must be driven or
    // his turn times out and the hand ends before alice ever acts.
    void bot.playLoop(40).catch(() => undefined);

    await page.goto("/");
    await page.locator(".identity-options summary").click();
    await page.locator("#agent-identity").setInputFiles(aliceKeyPath);
    await expect(page.locator("#identity-status")).toContainText("kept only in this tab");
    await page.locator("#ws-url").fill(`ws://127.0.0.1:${companion.port}`);
    await page.locator("#buy-in").fill("10");
    await page.locator("#btn-join").click();

    // Alice's seat lands only after her buy-in invoice is REALLY paid by
    // the companion through the player node.
    try {
      await expect.poll(() => server.seatRecords().length, { timeout: 120_000 }).toBe(2);
    } catch (err) {
      console.log("[diag] payment-status:", await page.locator("#payment-status").textContent().catch(() => "n/a"));
      console.log("[diag] identity-status:", await page.locator("#identity-status").textContent().catch(() => "n/a"));
      console.log("[diag] alice notifications:", JSON.stringify(
        server.notificationLogFor(alice.publicKey).slice(-3),
      ));
      throw err;
    }
    await expect(page.locator(".player-label:not(.empty)")).toHaveCount(2);
    await expect(page.locator("#status-chips")).toContainText("Local companion connected");

    try {
      await (server as unknown as { maybeStartHand: () => Promise<void> }).maybeStartHand();
      await expect(page.locator("#btn-check:enabled, #btn-call:enabled").first()).toBeEnabled({ timeout: 240_000 });
    } catch (err) {
      console.log("[diag] phase:", server.runtime.state.phase, "handNo:", server.runtime.state.handNo);
      console.log("[diag] payment-status:", await page.locator("#payment-status").textContent().catch(() => "n/a"));
      console.log("[diag] connection-details:", await page.locator("#connection-details").textContent().catch(() => "n/a"));
      console.log("[diag] action-status:", await page.locator("#action-status").textContent().catch(() => "n/a"));
      console.log("[diag] alice notifications:", JSON.stringify(server.notificationLogFor(alice.publicKey).slice(-4)));
      const adapter = (server as unknown as { adapter: { allEntries: () => unknown[] } }).adapter;
      console.log("[diag] adapter entries:", JSON.stringify(adapter.allEntries().slice(-5)));
      throw err;
    }
    for (let i = 0; i < 24; i++) {
      const phase = server.runtime.state.phase;
      if (phase === "HAND_COMPLETE" || phase === "WAITING") break;
      const check = page.locator("#btn-check");
      const call = page.locator("#btn-call");
      if (await check.isEnabled().catch(() => false)) {
        await check.click();
      } else if (await call.isEnabled().catch(() => false)) {
        await call.click();
      }
      await page.waitForTimeout(1_500);
    }
    await expect
      .poll(() => server.runtime.state.phase, { timeout: 240_000 })
      .toMatch(/HAND_COMPLETE|WAITING/);
    expect(server.runtime.state.handNo).toBeGreaterThanOrEqual(1);

    // Real money moved: at least the two buy-ins plus alice's blinds/bets
    // were settled on the table (evidence in the durable event log).
    const succeeded = events.events.filter((e) => e.eventType === "PaymentSucceeded");
    expect(succeeded.length).toBeGreaterThanOrEqual(3);

    // Conservation between hands on the live table.
    const seated = server.runtime.state.seats.filter((s) => s.playerId);
    expect(seated.reduce((a, s) => a + s.stack + s.handContribution, 0n)).toBe(2n * BUY_IN);
    await expect(page.locator("#chain-alert")).toBeHidden();
    expect(errors).toEqual([]);

    // Bob cashes out (payout over the real channel). Alice's seat stays —
    // the browser UI has no leave control yet; her stack is recoverable
    // through any future session with the same key.
    await bot.leave();
    expect(server.seatRecords().map((s) => s.playerId)).toEqual([alice.publicKey]);
  } finally {
    bot.close?.();
    await page.close();
    await companion.stop();
    await server.stop();
  }
});
