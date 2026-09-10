/**
 * Experimental hold-invoice settlement (handoff docs/03, roadmap P9).
 *
 * Idea: reserve betting liquidity as a HELD payment before committing the
 * poker action; release/cancel on hand completion. Implemented over the
 * simulator; the real FNN path is intentionally left as an adapter boundary
 * because hold semantics (settle_invoice / TLC expiry) must be validated
 * against a pinned build first.
 *
 * LIMITATION (docs/13 F): a hold invoice's condition is still
 * payment-hash/preimage based. It does NOT evaluate Texas Hold'em and does
 * NOT create six-party escrow. This strengthens the table-coordinator model
 * only.
 */

import type { Obligation, PaymentRequest, SettlementAdapter, SettlementRef, SettlementStatus } from "./types.ts";

/**
 * Placeholder for the long-term generalized CKB poker state channel
 * (docs/14). Never callable in V0: any attempt throws loudly.
 *
 * The protocol mechanics (co-signed allocation states, epochs, disputes)
 * are demonstrated by PokerChannelSim (./poker-channel.ts) — a research
 * simulator with no CKB scripts attached. Bridging that state machine to
 * real cells/adjudication is the P12 engineering milestone.
 */
export class FutureStateChannelSettlement implements SettlementAdapter {
  readonly name = "future-state-channel";
  onPaymentRequest(_handler: (req: PaymentRequest) => void): void {
    /* no-op */
  }
  async reserveOrPay(_obligation: Obligation): Promise<SettlementRef> {
    throw new Error(
      "NOT_IMPLEMENTED: generalized CKB poker state channel is an R&D target (docs/14), not a V0 settlement path",
    );
  }
  async getStatus(_ref: SettlementRef): Promise<SettlementStatus> {
    throw new Error("NOT_IMPLEMENTED: see docs/14");
  }
}
