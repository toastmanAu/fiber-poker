/**
 * Experimental hold-invoice settlement (roadmap P9, docs/03).
 *
 * Semantics: instead of settling a player's bet to finality BEFORE the
 * action commits, the table creates a HOLD invoice bound to H(preimage).
 * The player pays it; the funds lock in the channel (invoice "Received")
 * WITHOUT becoming final. Only then does the action commit. At hand
 * completion the table settles every held invoice for that hand (reveals
 * the preimage); on abort it cancels them — the funds simply return to the
 * players, no table goodwill required. That is the concrete player-side
 * improvement over immediate settlement: refunds become protocol-level.
 *
 * LIMITATION (docs/13 F — keep repeating it): the hold condition is still
 * payment-hash/preimage. It does not evaluate Texas Hold'em and does not
 * create six-party escrow. It strengthens the table-coordinator model only.
 *
 * Payouts (table→player) are immediate in this mode; holds apply to
 * player→table obligations.
 */

import type { FiberGateway } from "@fiber-poker/fiber-adapter";
import {
  holdInvoiceHashFor,
  holdPreimageFor,
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
  preimage: string;
  status: SettlementStatus;
  attempts: number;
  error?: string;
}

export class HoldInvoiceSettlement implements SettlementAdapter {
  readonly name = "hold-invoice-experimental";
  /** Entries keyed by ref.id; obligationId maps to the latest attempt. */
  private entries = new Map<string, HeldEntry>();
  private byObligation = new Map<string, HeldEntry>();
  private paymentHandlers = new Set<(req: PaymentRequest) => void>();
  private pollMs: number;

  constructor(private readonly gateway: FiberGateway, opts?: { pollMs?: number }) {
    if (!gateway.createHoldInvoice || !gateway.settleInvoice || !gateway.cancelInvoice) {
      throw new Error("HoldInvoiceSettlement requires a gateway with hold-invoice support");
    }
    this.pollMs = opts?.pollMs ?? 25;
  }

  onPaymentRequest(handler: (req: PaymentRequest) => void): void {
    this.paymentHandlers.add(handler);
  }

  async reserveOrPay(obligation: Obligation): Promise<SettlementRef> {
    const existing = this.byObligation.get(obligation.obligationId);
    if (existing && existing.status !== "FAILED" && existing.status !== "CANCELLED") {
      return existing.ref; // idempotent: never duplicate a live hold
    }
    const attempts = (existing?.attempts ?? 0) + 1;
    const ref: SettlementRef = { adapter: this.name, id: `${obligation.obligationId}#${attempts}` };

    if (obligation.direction === "TABLE_TO_PLAYER") {
      // Payouts are immediate in hold mode (handled by the gateway send path
      // of the coordinator; here we just track the send as INFLIGHT→SUCCEEDED
      // via payment status polling).
      const paymentHash = holdInvoiceHashFor(obligation);
      const entry: HeldEntry = {
        ref,
        obligation,
        paymentHash,
        preimage: "",
        status: "INFLIGHT",
        attempts,
      };
      this.entries.set(ref.id, entry);
      this.byObligation.set(obligation.obligationId, entry);
      await this.gateway.sendToPeer(obligation.playerId, BigInt(obligation.amountShannons), paymentHash);
      void this.pollPayout(entry).catch(() => {
        entry.status = "FAILED";
        entry.error = "payout poll error";
      });
      return ref;
    }

    // PLAYER_TO_TABLE: create the hold invoice bound to H(preimage).
    const preimage = holdPreimageFor(obligation);
    const preimageHash = holdInvoiceHashFor(obligation);
    const { paymentHash } = await this.gateway.createHoldInvoice!(BigInt(obligation.amountShannons), preimageHash);
    const entry: HeldEntry = {
      ref,
      obligation,
      paymentHash,
      preimage,
      status: "INFLIGHT",
      attempts,
    };
    this.entries.set(ref.id, entry);
    this.byObligation.set(obligation.obligationId, entry);

    const req: PaymentRequest = { ref, obligation, paymentHash };
    for (const handler of this.paymentHandlers) handler(req);

    void this.pollHold(entry).catch(() => {
      entry.status = "FAILED";
      entry.error = "hold poll error";
    });
    return ref;
  }

  /** Wait until the invoice is Received (HELD), Paid, or definitively dead. */
  private async pollHold(entry: HeldEntry): Promise<void> {
    for (;;) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      const status = await this.gateway.invoiceStatus(entry.paymentHash);
      if (status === "Received") {
        entry.status = "HELD";
        return;
      }
      if (status === "Paid") {
        entry.status = "SUCCEEDED";
        return;
      }
      if (status === "Cancelled" || status === "Expired") {
        entry.status = "FAILED";
        entry.error = `hold invoice ${status}`;
        return;
      }
    }
  }

  private async pollPayout(entry: HeldEntry): Promise<void> {
    for (;;) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      const status = await this.gateway.paymentStatus(entry.paymentHash);
      if (status === "Success") {
        entry.status = "SUCCEEDED";
        return;
      }
      if (status === "Failed") {
        entry.status = "FAILED";
        entry.error = "payout failed";
        return;
      }
    }
  }

  async getStatus(ref: SettlementRef): Promise<SettlementStatus> {
    return this.entries.get(ref.id)?.status ?? "PLANNED";
  }

  /** Settle a held obligation (hand completion policy). */
  async finalize(ref: SettlementRef, _resolution?: unknown): Promise<void> {
    const entry = this.entries.get(ref.id);
    if (!entry) throw new Error(`finalize: unknown ref ${ref.id}`);
    if (entry.status === "SUCCEEDED") return;
    if (entry.status !== "HELD") throw new Error(`finalize: ref ${ref.id} is ${entry.status}, not HELD`);
    await this.gateway.settleInvoice!(entry.paymentHash, entry.preimage);
    entry.status = "SUCCEEDED";
  }

  /** Cancel a held/open obligation (abort policy): funds return to the payer. */
  async cancel(ref: SettlementRef, reason: string): Promise<void> {
    const entry = this.entries.get(ref.id);
    if (!entry) return;
    if (entry.status === "SUCCEEDED") return; // already settled: cannot cancel
    try {
      await this.gateway.cancelInvoice!(entry.paymentHash);
      entry.status = "CANCELLED";
      entry.error = reason;
    } catch (e) {
      entry.error = `cancel failed: ${String(e)}`;
    }
  }

  /** Terminal states for the coordinator. */
  isTerminal(status: SettlementStatus): boolean {
    return status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED";
  }

  /** Await HELD or a terminal state. */
  async awaitHeld(ref: SettlementRef, timeoutMs = 30_000): Promise<SettlementStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.getStatus(ref);
      if (status === "HELD" || this.isTerminal(status)) return status;
      if (Date.now() > deadline) return "INFLIGHT";
      await new Promise((r) => setTimeout(r, Math.min(this.pollMs, 50)));
    }
  }

  entryFor(obligationId: string): HeldEntry | undefined {
    return this.byObligation.get(obligationId);
  }
}
