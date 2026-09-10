/**
 * Fiber integration over the simulated network (docs/09 section 5): peer
 * connectivity, channel opens (private + bidirectional), readiness,
 * payments in both directions, imbalance, insufficient liquidity, and the
 * ImmediateFiberSettlement adapter end to end.
 *
 * Real-devnet tests live behind FIBER_POKER_FNN_URL (see real-devnet.test.ts)
 * and are skipped unless the env var is set.
 */

import { describe, expect, it } from "vitest";
import {
  ImmediateFiberSettlement,
  obligationFromEngine,
  type Obligation,
} from "@fiber-poker/settlement";
import { SimNodeGateway, SimulatedFiberNetwork } from "@fiber-poker/fiber-adapter";

const CKB = 100_000_000n;

function obligation(table: string, player: string, dir: "PLAYER_TO_TABLE" | "TABLE_TO_PLAYER", amount: bigint): Obligation {
  return {
    tableId: table,
    handId: "h1",
    sequence: "1",
    actionHash: "aa".repeat(32),
    playerId: player,
    direction: dir,
    amountShannons: amount.toString(),
    reason: dir === "PLAYER_TO_TABLE" ? "BET" : "PAYOUT",
    obligationId: `h1:1:${dir}:${player}`,
  };
}

describe("simulated fiber network", () => {
  it("opens a private bidirectional channel and confirms ChannelReady", async () => {
    const net = new SimulatedFiberNetwork();
    const [table, player] = net.addRandomNodes(2, 1000n * CKB);
    const tableNode = net.node(table);
    const info = await tableNode.nodePubkey();
    expect(info).toBe(table);
    const ch = await tableNode.openChannel(player, 500n * CKB);
    const channels = await tableNode.listChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]!.stateName).toBe("ChannelReady");
    expect(channels[0]!.isPublic).toBe(false);
    expect(channels[0]!.isOneWay).toBe(false);
    expect(channels[0]!.channelId).toBe(ch.channelId);
    expect(channels[0]!.localBalance).toBe(500n * CKB);
  });

  it("moves value bilaterally and reflects imbalance", async () => {
    const net = new SimulatedFiberNetwork();
    const [a, b] = net.addRandomNodes(2, 1000n * CKB);
    const an = net.node(a);
    await an.openChannel(b, 100n * CKB);

    // Table pays player 30 CKB (player wins a pot).
    await an.sendToPeer(b, 30n * CKB);
    let ch = (await an.channelTo(b))!;
    expect(ch.localBalance).toBe(70n * CKB);
    expect(ch.remoteBalance).toBe(30n * CKB);

    // Player pays 50 CKB but only received 30: the payment records a
    // definitive Failed status (no channel-level throw across hops).
    const bn = net.node(b);
    const failed = await bn.sendToPeer(a, 50n * CKB);
    expect(await bn.paymentStatus(failed.paymentHash)).toBe("Failed");

    // Paying within balance works: player funds their own channel.
    await bn.openChannel(a, 40n * CKB);
    const channels = await bn.listChannels();
    expect(channels.some((c) => c.localBalance === 40n * CKB)).toBe(true);
  });

  it("rejects payments with no channel or insufficient liquidity", async () => {
    const net = new SimulatedFiberNetwork();
    const [a, b] = net.addRandomNodes(2, 1000n * CKB);
    const an = net.node(a);
    await an.openChannel(b, 10n * CKB);
    const failed = await an.sendToPeer(b, 11n * CKB);
    expect(await an.paymentStatus(failed.paymentHash)).toBe("Failed");

    const net2 = new SimulatedFiberNetwork();
    const [c, d] = net2.addRandomNodes(2, 1000n * CKB);
    await expect(net2.node(c).sendToPeer(d, 1n * CKB)).rejects.toThrow(/no channel/);
  });

  it("handles offline nodes", async () => {
    const net = new SimulatedFiberNetwork();
    const [a, b] = net.addRandomNodes(2, 1000n * CKB);
    net.setOffline(b, true);
    await expect(net.node(a).openChannel(b, 10n * CKB)).rejects.toThrow(/offline/);
  });
});

describe("ImmediateFiberSettlement over the simulator", () => {
  it("settles a player bet (player->table) when the player pays the invoice", async () => {
    const net = new SimulatedFiberNetwork();
    const [table, player] = net.addRandomNodes(2, 1000n * CKB);
    await net.node(player).openChannel(table, 200n * CKB);
    const adapter = new ImmediateFiberSettlement(net.node(table), { pollMs: 20, timeoutMs: 5000 });

    const requests: { paymentHash: string; amountShannons: string }[] = [];
    adapter.onPaymentRequest((req) => {
      requests.push({ paymentHash: req.paymentHash, amountShannons: req.obligation.amountShannons });
    });

    const ob = obligation("t1", player, "PLAYER_TO_TABLE", 5n * CKB);
    const ref = await adapter.reserveOrPay(ob);
    // Manually pay the invoice from the player node (hash from the request).
    net.payInvoice(player, requests[0]!.paymentHash);
    const status = await adapter.awaitTerminal(ref, 5000);
    expect(status).toBe("SUCCEEDED");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.amountShannons).toBe((5n * CKB).toString());
  });

  it("settles a payout (table->player) automatically", async () => {
    const net = new SimulatedFiberNetwork();
    const [table, player] = net.addRandomNodes(2, 1000n * CKB);
    await net.node(table).openChannel(player, 500n * CKB);
    const adapter = new ImmediateFiberSettlement(net.node(table), { pollMs: 20, timeoutMs: 5000 });

    const ob = obligation("t1", player, "TABLE_TO_PLAYER", 25n * CKB);
    const ref = await adapter.reserveOrPay(ob);
    const status = await adapter.awaitTerminal(ref, 5000);
    expect(status).toBe("SUCCEEDED");
    // Balance moved across the channel.
    const ch = (await net.node(table).channelTo(player))!;
    expect(ch.localBalance).toBe(475n * CKB);
  });

  it("fails definitively on insufficient payout liquidity (never stays pending)", async () => {
    const net = new SimulatedFiberNetwork();
    const [table, player] = net.addRandomNodes(2, 1000n * CKB);
    await net.node(table).openChannel(player, 10n * CKB);
    const adapter = new ImmediateFiberSettlement(net.node(table), { pollMs: 20, timeoutMs: 5000 });

    const ob = obligation("t1", player, "TABLE_TO_PLAYER", 500n * CKB);
    const ref = await adapter.reserveOrPay(ob);
    const status = await adapter.awaitTerminal(ref, 5000);
    expect(status).toBe("FAILED");
  });

  it("keeps obligation->payment correlation deterministic", async () => {
    const { paymentHashFor } = await import("@fiber-poker/settlement");
    const net = new SimulatedFiberNetwork();
    const [table, player] = net.addRandomNodes(2, 1000n * CKB);
    const ob = obligationFromEngine(
      table,
      "h9",
      3n,
      "ab".repeat(32),
      { kind: "PAY_TABLE", playerId: player, amount: 2n, reason: "BET", obligationId: "h9:3:BET:me" },
    );
    expect(paymentHashFor(ob)).toBe(paymentHashFor(ob));
  });
});
