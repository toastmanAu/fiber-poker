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

import type { FiberGateway } from "@fiber-poker/fiber-adapter";
import {
  paymentHashFor,
  type Obligation,
  type PaymentRequest,
  type SettlementAdapter,
  type SettlementRef,
  type SettlementStatus,
} from "./types.ts";

interface HeldEntry {
  ref: SettlementRef;
  obligation: Obligation;
  paymentHash: string;
  status: SettlementStatus;
}

export class HoldInvoiceSettlement implements SettlementAdapter {
  readonly name = "hold-invoice-experimental";
  private entries = new Map<string, HeldEntry>();
  private paymentHandler: ((req: PaymentRequest) => void) | null = null;

  constructor(private readonly gateway: FiberGateway) {}

  onPaymentRequest(handler: (req: PaymentRequest) => void): void {
    this.paymentHandler = handler;
  }

  async reserveOrPay(obligation: Obligation): Promise<SettlementRef> {
    const existing = this.entries.get(obligation.obligationId);
    if (existing) return existing.ref;
    const paymentHash = paymentHashFor(obligation);
    const ref: SettlementRef = { adapter: this.name, id: obligation.obligationId };
    const entry: HeldEntry = { ref, obligation, paymentHash, status: "HELD" };
    this.entries.set(obligation.obligationId, entry);
    if (obligation.direction === "PLAYER_TO_TABLE") {
      this.paymentHandler?.({ ref, obligation, paymentHash });
    }
    return ref;
  }

  async getStatus(ref: SettlementRef): Promise<SettlementStatus> {
    return this.entries.get(ref.id)?.status ?? "PLANNED";
  }

  /** Release a held obligation when the poker outcome commits it. */
  async finalize(ref: SettlementRef): Promise<void> {
    const entry = this.entries.get(ref.id);
    if (entry && entry.status === "HELD") entry.status = "SUCCEEDED";
  }

  /** Cancel a held obligation when the hand voids it. */
  async cancel(ref: SettlementRef, reason: string): Promise<void> {
    const entry = this.entries.get(ref.id);
    if (entry && entry.status === "HELD") {
      entry.status = "CANCELLED";
      void reason;
    }
  }

  entryFor(obligationId: string): HeldEntry | undefined {
    return this.entries.get(obligationId);
  }
}

/**
 * Placeholder for the long-term generalized CKB poker state channel
 * (docs/14). Never callable in V0: any attempt throws loudly.
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
