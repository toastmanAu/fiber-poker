/**
 * Force-close and watchtower tests (handoff docs/03, docs/07, roadmap P6).
 *
 * Simulator semantics mirror real channel guarantees closely enough to
 * exercise the recovery logic:
 *  - cooperative close: both sign; balances settle immediately;
 *  - unilateral (force) close: closer's funds return, counterparty payout
 *    matures on-chain after a dispute delay (net.tick());
 *  - stale commitment broadcast (claimed version < witnessed version):
 *    the watchtower punishes — the cheater forfeits their channel balance.
 */

import { describe, expect, it } from "vitest";
import { SimulatedFiberNetwork } from "@fiber-poker/fiber-adapter";

const CKB = 100_000_000n;

describe("force close semantics (simulated)", () => {
  it("cooperative close settles immediately and logs the mode", async () => {
    const net = new SimulatedFiberNetwork();
    const [a, b] = net.addRandomNodes(2, 1000n * CKB);
    const gateway = net.node(a);
    const { channelId } = await gateway.openChannel(b, 100n * CKB);
    await net.node(b).sendToPeer(a, 40n * CKB); // b wins 40 across the channel

    await gateway.shutdownChannel(channelId);
    expect(net.channelById(channelId)!.state).toBe("Closed");
    expect(net.closureLog().at(-1)!.mode).toBe("cooperative");
  });

  it("unilateral close settles to Closed after the dispute delay", async () => {
    const net = new SimulatedFiberNetwork();
    const [a, b] = net.addRandomNodes(2, 1000n * CKB);
    const gateway = net.node(a);
    await gateway.openChannel(b, 100n * CKB);
    const channelId = (await gateway.listChannels())[0]!.channelId;
    // b won 30 CKB of the channel balance (local 70 / remote 30).
    await net.setChannelBalances(channelId, 70n * CKB, 30n * CKB);

    await gateway.forceCloseTo(b);
    const ch = net.channelById(channelId);
    expect(ch!.state).toBe("ShuttingDown");

    // Counterparty payout matures after two ticks.
    net.tick();
    net.tick();
    expect(net.channelById(ch!.channelId)!.state).toBe("Closed");
  });

  it("punishes a stale commitment when the watchtower witnessed a newer one", async () => {
    const net = new SimulatedFiberNetwork();
    const [a, b] = net.addRandomNodes(2, 1000n * CKB);
    const gateway = net.node(a);
    await gateway.openChannel(b, 100n * CKB);
    const channelId = (await gateway.listChannels())[0]!.channelId;

    // The watchtower registers the channel and witnesses every update.
    const tower = net.watchtower;
    tower.register(channelId);
    expect(tower.witnessedVersion(channelId)).toBe(1);

    // Several state updates happen (payments move balance, version bumps).
    await net.setChannelBalances(channelId, 70n * CKB, 30n * CKB);
    expect(net.commitmentVersion(channelId)).toBe(2);
    expect(tower.witnessedVersion(channelId)).toBe(2);

    // Node a broadcasts a STALE commitment (version 1) to close.
    await gateway.forceCloseTo(b, 1);
    expect(net.closureLog().at(-1)!.mode).toBe("force-punished");
    expect(tower.seesStaleClose(channelId)).toBe(true);

    // Punishment: the cheater forfeits their whole channel balance to b.
    const ch = net.channelById(channelId)!;
    expect(ch.balanceA).toBe(0n);
    expect(ch.balanceB).toBe(100n * CKB);
  });

  it("an honest unilateral close is NOT punished even with a watchtower", async () => {
    const net = new SimulatedFiberNetwork();
    const [a, b] = net.addRandomNodes(2, 1000n * CKB);
    const gateway = net.node(a);
    await gateway.openChannel(b, 100n * CKB);
    const channelId = (await gateway.listChannels())[0]!.channelId;
    net.watchtower.register(channelId);

    await net.setChannelBalances(channelId, 60n * CKB, 40n * CKB);
    // Close with the CURRENT version (default).
    await gateway.forceCloseTo(b);
    expect(net.closureLog().at(-1)!.mode).toBe("force");
    expect(net.watchtower.seesStaleClose(channelId)).toBe(false);
  });

  it("an unregistered watchtower cannot punish (coverage matters)", async () => {
    const net = new SimulatedFiberNetwork();
    const [a, b] = net.addRandomNodes(2, 1000n * CKB);
    const gateway = net.node(a);
    await gateway.openChannel(b, 100n * CKB);
    const channelId = (await gateway.listChannels())[0]!.channelId;
    // No tower.register(channelId): updates are unwitnessed.

    await net.setChannelBalances(channelId, 70n * CKB, 30n * CKB);
    await gateway.forceCloseTo(b, 1); // stale claim, but nobody watched
    expect(net.closureLog().at(-1)!.mode).toBe("force");
    // The stale close stands: channel settles at the claimed (old) state.
    expect(net.channelById(channelId)!.state).toBe("ShuttingDown");
  });
});
