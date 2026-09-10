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

export interface FiberGateway {
  nodePubkey(): Promise<string>;
  connectPeer(address: string): Promise<void>;
  openChannel(peerPubkey: string, fundingAmount: bigint): Promise<{ channelId: string }>;
  listChannels(): Promise<GatewayChannel[]>;
  /** Convenience for topology checks. */
  channelTo?(peerPubkey: string): Promise<GatewayChannel | undefined>;
  shutdownChannel(channelId: string, opts?: { force?: boolean }): Promise<void>;
  /** Payee-side: create an invoice the player can pay, bound to a specific
   *  payment hash when given (correlation with the poker transcript). */
  createInvoice(amount: bigint, paymentHash?: string): Promise<{ paymentHash: string }>;
  invoiceStatus(paymentHash: string): Promise<"Open" | "Received" | "Paid" | "Cancelled" | "Expired" | "Unknown">;
  /** Hold invoice: created from the payee's preimage; payer funds lock at
   *  "Received" until settled. The response hash is authoritative (it is
   *  derived by the node, not precomputable from the obligation). */
  createHoldInvoice?(amount: bigint, preimage: string): Promise<{ paymentHash: string }>;
  /** Payee settles a held invoice by revealing the preimage. */
  settleInvoice?(paymentHash: string, preimage: string): Promise<void>;
  /** Payee cancels a held/open invoice; payer funds are released. */
  cancelInvoice?(paymentHash: string): Promise<void>;
  /** Payer-side: keysend-style direct payment to a peer's pubkey. */
  sendToPeer(targetPubkey: string, amount: bigint, paymentHash?: string): Promise<{ paymentHash: string }>;
  paymentStatus(paymentHash: string): Promise<"Created" | "Inflight" | "Success" | "Failed" | "Unknown">;
}
