/**
 * ImmediateFiberSettlement: payment-before-commit over real Fiber channels.
 *
 * PLAYER_TO_TABLE (blinds/bets/calls/raises):
 *   1. table creates an invoice for the exact amount (paymentHash derived
 *      deterministically from the obligation id so retries are idempotent);
 *   2. PAYMENT_REQUIRED flows to the player connection;
 *   3. the player's Fiber node pays the invoice;
 *   4. the adapter polls get_invoice until Paid -> SUCCEEDED.
 *
 * TABLE_TO_PLAYER (payouts/refunds):
 *   1. table sends a keysend-style payment to the player's channel;
 *   2. polls get_payment until Success -> SUCCEEDED.
 *
 * Failure policy: FAILED only after the backend reports a definitive
 * failure; the coordinator decides what poker policy to apply. This adapter
 * never commits poker state itself.
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

interface Entry {
  ref: SettlementRef;
  obligation: Obligation;
  paymentHash: string;
  status: SettlementStatus;
  error?: string;
  attempts: number;
}

/** True while an entry still represents money that may move. */
function isLive(status: SettlementStatus): boolean {
  return status === "PLANNED" || status === "INFLIGHT" || status === "HELD" || status === "SUCCEEDED";
}

export class ImmediateFiberSettlement implements SettlementAdapter {
  readonly name = "immediate-fiber";
  /** Entries keyed by ref.id; obligationId maps to the latest attempt. */
  private entries = new Map<string, Entry>();
  private byObligation = new Map<string, Entry>();
  private paymentHandlers = new Set<(req: PaymentRequest) => void>();
  private pollMs: number;
  private timeoutMs: number;
  /** Poker session key -> Fiber node pubkey (docs/15). Identity by default.
   *  Mutable: the table server binds this to its live peer registry. */
  resolvePeer: (playerId: string) => string;

  constructor(
    private readonly gateway: FiberGateway,
    opts?: {
      pollMs?: number;
      timeoutMs?: number;
      /** Poker session key -> Fiber node pubkey (docs/15). */
      resolvePeer?: (playerId: string) => string;
    },
  ) {
    this.pollMs = opts?.pollMs ?? 300;
    this.timeoutMs = opts?.timeoutMs ?? 60_000;
    this.resolvePeer = opts?.resolvePeer ?? ((id: string) => id);
  }

  onPaymentRequest(handler: (req: PaymentRequest) => void): void {
    this.paymentHandlers.add(handler);
  }

  async reserveOrPay(obligation: Obligation): Promise<SettlementRef> {
    const existing = this.entries.get(obligation.obligationId);
    if (existing && isLive(existing.status)) {
      return existing.ref; // idempotent: never a duplicate live payment
    }
    // A terminal failure gets a fresh attempt (new ref id, new invoice).
    const attempts = (existing?.attempts ?? 0) + 1;
    const paymentHash = paymentHashFor(obligation);
    const ref: SettlementRef = { adapter: this.name, id: `${obligation.obligationId}#${attempts}` };
    const entry: Entry = { ref, obligation, paymentHash, status: "INFLIGHT", attempts };
    this.entries.set(ref.id, entry);
    this.byObligation.set(obligation.obligationId, entry);

    if (obligation.direction === "PLAYER_TO_TABLE") {
      // rc7 flow: the invoice is created from the payee's own preimage and
      // auto-settles when the payer's TLC arrives. Correlation with the
      // poker transcript travels via obligationId in the event log (the
      // old deterministic payment-hash derivation is unimplementable on
      // rc7 — a hash-only invoice can never be settled).
      const inv = await this.gateway.createInvoice(BigInt(obligation.amountShannons));
      entry.paymentHash = inv.paymentHash;
      entry.status = "INFLIGHT";
      for (const handler of this.paymentHandlers) {
        handler({ ref, obligation, paymentHash: inv.paymentHash, invoiceAddress: inv.invoiceAddress });
      }
      this.pollInBackground(entry).catch(() => {
        entry.status = "FAILED";
        entry.error = "poll error";
      });
    } else {
      // Payout / refund: keysend to the player's FIBER peer. rc7 forbids a
      // payer-supplied payment_hash on keysend — the RESPONSE hash is the
      // poll handle; correlation with the poker transcript travels via
      // obligationId in the event log.
      const sent = await this.gateway.sendToPeer(this.resolvePeer(obligation.playerId), BigInt(obligation.amountShannons));
      entry.paymentHash = sent.paymentHash;
      this.pollInBackground(entry).catch(() => {
        entry.status = "FAILED";
        entry.error = "poll error";
      });
    }
    return ref;
  }

  private async pollInBackground(entry: Entry): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    const { obligation } = entry;
    for (;;) {
      if (Date.now() > deadline) {
        entry.status = "FAILED";
        entry.error = "settlement timeout";
        return;
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
      if (obligation.direction === "PLAYER_TO_TABLE") {
        const status = await this.gateway.invoiceStatus(entry.paymentHash);
        if (status === "Paid") {
          entry.status = "SUCCEEDED";
          return;
        }
        if (status === "Cancelled" || status === "Expired") {
          entry.status = "FAILED";
          entry.error = `invoice ${status}`;
          return;
        }
      } else {
        const status = await this.gateway.paymentStatus(entry.paymentHash);
        if (status === "Success") {
          entry.status = "SUCCEEDED";
          return;
        }
        if (status === "Failed") {
          entry.status = "FAILED";
          entry.error = "payment failed";
          return;
        }
      }
    }
  }

  async getStatus(ref: SettlementRef): Promise<SettlementStatus> {
    return this.entries.get(ref.id)?.status ?? "PLANNED";
  }

  async cancel(ref: SettlementRef, reason: string): Promise<void> {
    const entry = this.entries.get(ref.id);
    if (entry && (entry.status === "PLANNED" || entry.status === "INFLIGHT" || entry.status === "HELD")) {
      entry.status = "CANCELLED";
      entry.error = reason;
    }
  }

  /** Test/driver helper: await terminal status. */
  async awaitTerminal(ref: SettlementRef, timeoutMs = 90_000): Promise<SettlementStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.getStatus(ref);
      if (status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED") return status;
      if (Date.now() > deadline) throw new Error("awaitTerminal timeout");
      await new Promise((r) => setTimeout(r, Math.min(this.pollMs, 100)));
    }
  }

  entry(obligationId: string): Entry | undefined {
    return this.byObligation.get(obligationId);
  }

  /** Diagnostics: every settlement attempt this adapter has tracked. */
  allEntries(): { ref: string; obligationId: string; direction: string; amount: string; status: SettlementStatus; error?: string }[] {
    return [...this.entries.values()].map((e) => ({
      ref: e.ref.id,
      obligationId: e.obligation.obligationId,
      direction: e.obligation.direction,
      amount: e.obligation.amountShannons,
      status: e.status,
      error: e.error,
    }));
  }
}
