/**
 * LiquidityManager (docs/04): pre-hand payout-capacity gate, pause/resume,
 * top-up and rebalance as explicit, fail-closed operator paths.
 */

import { describe, expect, it } from "vitest";
import { SimNodeGateway, SimulatedFiberNetwork } from "@fiber-poker/fiber-adapter";
import { LiquidityManager } from "@fiber-poker/table-server";

const CKB = 100_000_000n;

describe("liquidity manager", () => {
  it("admits a hand when every player's stack is payable on their own channel", async () => {
    const net = new SimulatedFiberNetwork();
    const [table, a, b] = net.addRandomNodes(3, 1000n * CKB);
    void table;
    const gateway = net.node(a);
    await gateway.openChannel(b, 500n * CKB);

    // Direct liquidity objects (bypassing the table binding) via the manager:
    const mgr = new LiquidityManager(gateway);
    await mgr.refresh([{ playerId: b }]);

    const ok = mgr.canStartHand(new Map([[b, 400n * CKB]]));
    expect(ok.ok).toBe(true);
    const bad = mgr.canStartHand(new Map([[b, 600n * CKB]]));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/insufficient payout capacity/);
  });

  it("fails closed when a player has no channel at all", async () => {
    const net = new SimulatedFiberNetwork();
    const [table] = net.addRandomNodes(1, 1000n * CKB);
    const mgr = new LiquidityManager(net.node(table));
    await mgr.refresh([{ playerId: "ghost" }]);
    const res = mgr.canStartHand(new Map([["ghost", 1n]]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no channel/);
  });

  it("passes through in fake-settlement mode (no real directional liquidity)", () => {
    const mgr = new LiquidityManager(null);
    expect(mgr.canStartHand(new Map([["p", 999n * CKB]]))).toEqual({ ok: true });
  });

  it("pauses hands on failure and resumes explicitly", () => {
    const mgr = new LiquidityManager(null);
    mgr.pause("payout failed for player X");
    const paused = mgr.canStartHand(new Map());
    expect(paused.ok).toBe(false);
    if (!paused.ok) expect(paused.reason).toContain("payout failed");
    mgr.resume();
    expect(mgr.canStartHand(new Map()).ok).toBe(true);
  });

  it("exposes top-up and rebalance as explicit NOT_IMPLEMENTED operator paths", async () => {
    const net = new SimulatedFiberNetwork();
    const [table, player] = net.addRandomNodes(2, 1000n * CKB);
    await net.node(table).openChannel(player, 100n * CKB);
    const mgr = new LiquidityManager(net.node(table));
    await mgr.refresh([{ playerId: player }]);
    await expect(mgr.topUp(player, 1n)).rejects.toThrow(/top-up/);
    await expect(mgr.rebalance(player, 1n)).rejects.toThrow(/rebalanc/);
    // With no channel binding at all, top-up fails closed as well.
    const bare = new LiquidityManager(net.node(table));
    await expect(bare.topUp("ghost", 1n)).rejects.toThrow();
  });

  it("tracks per-channel balances from the gateway", async () => {
    const net = new SimulatedFiberNetwork();
    const [table, player] = net.addRandomNodes(2, 1000n * CKB);
    const gateway = net.node(table);
    await gateway.openChannel(player, 300n * CKB);
    const mgr = new LiquidityManager(gateway);
    await mgr.refresh([{ playerId: player }]);
    const snap = mgr.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]!.localBalance).toBe(300n * CKB);
    expect(snap[0]!.channelId).toBeTruthy();
  });
});
