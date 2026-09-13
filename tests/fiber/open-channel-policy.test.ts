/**
 * P2 channel-opening policy: classifyFundingAmount rules and the
 * ChannelManager wiring (floor bump before open, abandon + single retry on
 * a stalled open, hard block below the reserve) — exercised against a
 * stub gateway that records every call.
 */

import { describe, expect, it } from "vitest";
import { ChannelOpenStalledError, classifyFundingAmount, type FiberGateway, type GatewayChannel } from "@fiber-poker/fiber-adapter";
import { ChannelManager } from "../../apps/table-server/src/channels.ts";

const CKB = 100_000_000n;

describe("classifyFundingAmount", () => {
  it("hard-blocks opens below the 100 CKB reserve floor", () => {
    const v = classifyFundingAmount(50n * CKB, 5n * CKB);
    expect(v.verdict).toBe("below-reserve");
  });

  it("bumps to the peer's gossiped floor instead of pinning in NegotiatingFunding", () => {
    const v = classifyFundingAmount(100n * CKB, 150n * CKB);
    expect(v.verdict).toBe("bumped-to-peer-floor");
    if (v.verdict === "bumped-to-peer-floor") {
      expect(v.openAmount).toBe(150n * CKB);
    }
  });

  it("opens as requested at or above the floor, and without gossip knowledge", () => {
    expect(classifyFundingAmount(400n * CKB, 99n * CKB).verdict).toBe("ok");
    expect(classifyFundingAmount(400n * CKB, undefined).verdict).toBe("ok");
  });
});

interface Recorded {
  opens: { peer: string; amount: bigint }[];
  abandons: string[];
  failFirstOpen: boolean;
}

function stubGateway(rec: Recorded, floor?: bigint): FiberGateway {
  return {
    async nodePubkey() {
      return "stub-node";
    },
    async connectPeer() {},
    async openChannel(peer: string, fundingAmount: bigint) {
      rec.opens.push({ peer, amount: fundingAmount });
      if (rec.failFirstOpen && rec.opens.length === 1) {
        // The gateway already abandoned the ghost before failing.
        rec.abandons.push("stall-ghost");
        throw new ChannelOpenStalledError(peer, "stall-ghost");
      }
      return { channelId: `ch-${rec.opens.length}` };
    },
    async listChannels(): Promise<GatewayChannel[]> {
      return [];
    },
    async shutdownChannel() {},
    async createInvoice(amount: bigint) {
      return { paymentHash: `h-${amount}`, invoiceAddress: `addr-${amount}` };
    },
    async invoiceStatus() {
      return "Paid";
    },
    async sendToPeer() {
      return { paymentHash: "p" };
    },
    async paymentStatus() {
      return "Success";
    },
    async peerAutoAcceptFloor() {
      return floor;
    },
    async abandonChannel(channelId: string) {
      rec.abandons.push(channelId);
    },
  };
}

function managerFor(gateway: FiberGateway): ChannelManager {
  const notifications: unknown[] = [];
  return new ChannelManager(gateway, 100n * CKB, () => notifications.push(0), (id) => id);
}

describe("ChannelManager open policy", () => {
  it("bumps the open to the peer's floor when gossip knows a higher minimum", async () => {
    const rec: Recorded = { opens: [], abandons: [], failFirstOpen: false };
    const cm = managerFor(stubGateway(rec, 150n * CKB));
    const id = await cm.ensureChannel("player-1");
    expect(id).toBe("ch-1");
    expect(rec.opens).toHaveLength(1);
    expect(rec.opens[0]!.amount).toBe(150n * CKB); // bumped, not the 100 CKB default
  });

  it("hard-blocks below-reserve funding before any channel RPC fires", async () => {
    const rec: Recorded = { opens: [], abandons: [], failFirstOpen: false };
    // The manager's default funding is below the floor for this stub.
    const notifications: unknown[] = [];
    const cm = new ChannelManager(stubGateway(rec), 50n * CKB, (n) => notifications.push(n), (id) => id);
    await expect(cm.ensureChannel("player-1")).rejects.toThrow(/below the hard floor/);
    expect(rec.opens).toHaveLength(0);
  });

  it("retries exactly once after a stalled open (ghost already abandoned)", async () => {
    const rec: Recorded = { opens: [], abandons: [], failFirstOpen: true };
    const cm = managerFor(stubGateway(rec, undefined));
    const id = await cm.ensureChannel("player-1");
    expect(id).toBe("ch-2"); // the retry's channel
    expect(rec.opens).toHaveLength(2); // failed attempt + one retry, no more
    expect(rec.opens[0]!.amount).toBe(rec.opens[1]!.amount);
    // Lifecycle ends at CHANNEL_READY despite the stall.
    expect(cm.status("player-1")).toBe("CHANNEL_READY");
  });
});
