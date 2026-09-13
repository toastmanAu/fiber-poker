/**
 * Narrow gateway interface over a Fiber node. This is the ONLY seam through
 * which poker code may touch Fiber. It is implemented by:
 *   - RealFiberGateway  (HTTP JSON-RPC to a local/remote FNN v0.9.0 node)
 *   - SimNodeGateway    (in-process simulator for tests/CI)
 *
 * Browsers never see this interface or its credentials.
 */

export interface GatewayChannel {
  channelId: string;
  peerPubkey: string;
  stateName: string;
  localBalance: bigint;
  remoteBalance: bigint;
  offeredTlcBalance: bigint;
  receivedTlcBalance: bigint;
  isPublic: boolean;
  isOneWay: boolean;
}

export const FNN_DEFAULT_FUNDING_FEE_RATE = 20_000n; // live-verified floor: fnn's 1000 underpays
export const FNN_MIN_VIABLE_CHANNEL_FUNDING = 100n * 100_000_000n; // 100 CKB

export interface FiberGateway {
  nodePubkey(): Promise<string>;
  connectPeer(address: string): Promise<void>;
  openChannel(peerPubkey: string, fundingAmount: bigint): Promise<{ channelId: string }>;
  listChannels(): Promise<GatewayChannel[]>;
  /** Convenience for topology checks. */
  channelTo?(peerPubkey: string): Promise<GatewayChannel | undefined>;
  shutdownChannel(channelId: string, opts?: { force?: boolean }): Promise<void>;
  /** Payee-side: create an invoice the player can pay (rc7: payee-preimage
   *  form; the invoice address is what the payer needs for send_payment). */
  createInvoice(amount: bigint, paymentHash?: string): Promise<{ paymentHash: string; invoiceAddress?: string }>;
  invoiceStatus(paymentHash: string): Promise<"Open" | "Received" | "Paid" | "Cancelled" | "Expired" | "Unknown">;
  /** Hold invoice: created from the payee's preimage; payer funds lock at
   *  "Received" until settled. The response hash is authoritative (it is
   *  derived by the node, not precomputable from the obligation). */
  createHoldInvoice?(amount: bigint, preimage: string): Promise<{ paymentHash: string; invoiceAddress?: string }>;
  /** Payee settles a held invoice by revealing the preimage. */
  settleInvoice?(paymentHash: string, preimage: string): Promise<void>;
  /** Payee cancels a held/open invoice; payer funds are released. */
  cancelInvoice?(paymentHash: string): Promise<void>;
  /** Payer-side: keysend-style direct payment to a peer's pubkey. */
  sendToPeer(targetPubkey: string, amount: bigint, paymentHash?: string): Promise<{ paymentHash: string }>;
  /** Payer-side: pay an invoice address (player agent flow). */
  payInvoice?(invoice: string): Promise<{ paymentHash: string }>;
  paymentStatus(paymentHash: string): Promise<"Created" | "Inflight" | "Success" | "Failed" | "Unknown">;
  /** P2: the peer's gossiped auto-accept minimum funding (shannons);
   *  undefined when the gossip lookup cannot find the peer. */
  peerAutoAcceptFloor?(peerPubkey: string): Promise<bigint | undefined>;
  /** P2: abandon a stuck pre-materialized channel (NegotiatingFunding
   *  ghost). Closed corpses are NOT abandonable (rc7 answers "not found")
   *  — they are already terminal and harmless. */
  abandonChannel?(channelId: string): Promise<void>;
}
