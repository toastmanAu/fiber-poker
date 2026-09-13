/**
 * LIVE Fiber node integration (gated).
 *
 * Runs only when FIBER_POKER_FNN_URL is set:
 *
 *   FIBER_POKER_FNN_URL=http://192.168.68.80:8227 \
 *   FIBER_POKER_FNN_TOKEN=<base64 biscuit> \
 *   npx vitest run tests/fiber/live-node.test.ts
 *
 * Scope safety:
 *  - READ-ONLY probes (node_info, list_channels, list_peers) always run.
 *  - The invoice lifecycle (new_invoice -> get_invoice -> cancel_invoice)
 *    moves NO funds and is safe; it runs with a read/write token.
 *  - Channel open/close and payments move testnet funds and need explicit
 *    operator consent: they run only when FIBER_POKER_LIVE_CHANNELS=1.
 */

import { describe, expect, it } from "vitest";
import { FiberRpcClient, FiberRpcError, RealFiberGateway } from "@fiber-poker/fiber-adapter";

const URL_ = process.env.FIBER_POKER_FNN_URL;
const TOKEN = process.env.FIBER_POKER_FNN_TOKEN;
const CHANNEL_TESTS = process.env.FIBER_POKER_LIVE_CHANNELS === "1";

const d = URL_ ? describe : describe.skip;

function client(): FiberRpcClient {
  return new FiberRpcClient({ url: URL_!, authToken: TOKEN, timeoutMs: 15_000 });
}

d("live FNN node", () => {
  it("authenticates and answers node_info in the v0.9.0 shape", async () => {
    const rpc = client();
    const info = await rpc.nodeInfo();
    // Live rc7 shape: `pubkey` (not node_pubkey), node_name nullable.
    expect(info.pubkey).toMatch(/^(02|03)[0-9a-f]{64}$/);
    expect(typeof info.version).toBe("string");
  });

  it("rejects a bad token with the documented error envelope", async () => {
    if (TOKEN) return; // only meaningful without a valid token
    const bad = new FiberRpcClient({ url: URL_!, authToken: "invalid-token" });
    await expect(bad.nodeInfo()).rejects.toThrow(FiberRpcError);
  });

  it("resolves a peer's gossiped auto-accept floor via graph_nodes (P2)", async () => {
    const gateway = new RealFiberGateway({ url: URL_!, authToken: TOKEN, currency: "Fibt" });
    const { channels } = await client().listChannels({});
    const peer = channels.find((c) => c.pubkey)?.pubkey;
    if (!peer) return; // no peers connected: nothing to look up
    const floor = await gateway.peerAutoAcceptFloor(peer);
    // A gossiped floor is a positive shannons amount when present.
    expect(floor === undefined || floor > 0n).toBe(true);
    if (floor !== undefined) console.log(`[live] peer ${peer.slice(0, 12)}… auto-accept floor: ${floor} shannons`);
  });

  it("lists channels with PascalCase state names and 0x-hex balances", async () => {
    const rpc = client();
    const { channels } = await rpc.listChannels({});
    expect(Array.isArray(channels)).toBe(true);
    for (const c of channels) {
      expect(c.channel_id).toMatch(/^0x[0-9a-f]+$/);
      expect(typeof c.state.state_name).toBe("string"); // nested, adjacently tagged
      expect(c.state.state_name).toMatch(/^[A-Z][A-Za-z]+$/); // PascalCase (e.g. ChannelReady)
      expect(c.local_balance).toMatch(/^0x[0-9a-f]+$/);
      expect(c.remote_balance).toMatch(/^0x[0-9a-f]+$/);
      expect(c.pubkey).toMatch(/^(02|03)[0-9a-f]{64}$/);
    }
  });

  it("creates, queries, and cancels an invoice (no funds moved)", async () => {
    const rpc = client();
    // Fixed correlation hash: deterministic, unique per run day.
    const paymentHash = `0x${Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`fiber-poker-live-${new Date().toISOString().slice(0, 10)}-${process.pid}`)),
    ).toString("hex")}`;
    const inv = await rpc.newInvoice({ amount: 1_000_000n, currency: "Fibt", payment_hash: paymentHash }); // 0.01 CKB
    expect(inv.invoice_address).toBeTruthy();
    expect(inv.invoice.data.payment_hash.toLowerCase()).toBe(paymentHash);

    const lookup = await rpc.getInvoice({ payment_hash: paymentHash });
    expect(lookup.status).toBe("Open");

    await rpc.cancelInvoice({ payment_hash: paymentHash });
    const cancelled = await rpc.getInvoice({ payment_hash: paymentHash });
    expect(cancelled.status).toBe("Cancelled");
  });

  it.skipIf(!CHANNEL_TESTS)(
    "opens and cooperatively closes a channel (moves testnet funds)",
    async () => {
      const rpc = client();
      // Requires FIBER_POKER_LIVE_PEER (multiaddr) and funds on the node.
      const peer = process.env.FIBER_POKER_LIVE_PEER;
      if (!peer) throw new Error("FIBER_POKER_LIVE_PEER not set");
      await rpc.connectPeer(peer);
      const { temporary_channel_id } = await rpc.openChannel({
        peer_id: peer,
        funding_amount: 100_000_000n, // 1 CKB
        public: false,
        one_way: false,
      });
      expect(temporary_channel_id).toBeTruthy();
      // Accept happens on the peer; shutdown whatever materialized.
      const { channels } = await rpc.listChannels({});
      const mine = channels.find((c) => c.state_name !== "Closed");
      if (mine) {
        await rpc.shutdownChannel({ channel_id: mine.channel_id });
      }
    },
  );
});
