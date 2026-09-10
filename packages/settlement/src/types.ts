/**
 * Settlement adapters (handoff docs/04 + interfaces/settlement.ts).
 *
 * IRON RULE: economic state must never outrun Fiber state. The coordinator
 * may only apply a value-changing poker transition after the adapter for its
 * obligation reports SUCCEEDED. Poker state therefore never commits value
 * that Fiber has not settled.
 *
 * Adapter lifecycle per obligation:
 *   PLANNED -> INFLIGHT -> (HELD for hold-invoice experiment) -> SUCCEEDED
 *                                                     \-> FAILED / CANCELLED
 */

import { ckbHash } from "@fiber-poker/protocol";
import type { EconomicObligation } from "@fiber-poker/poker-engine";

export type SettlementStatus = "PLANNED" | "INFLIGHT" | "HELD" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface SettlementRef {
  adapter: string;
  id: string;
}

export type Direction = "PLAYER_TO_TABLE" | "TABLE_TO_PLAYER";

/** The correlation-anchored obligation the coordinator fulfils. */
export interface Obligation {
  tableId: string;
  handId: string;
  sequence: string;
  actionHash: string;
  playerId: string;
  direction: Direction;
  amountShannons: string;
  reason: string;
  /** Deterministic dedup id: `${handId}:${sequence}:${reason}:${playerId}` */
  obligationId: string;
}

/** Map an engine obligation onto a settlement obligation. */
export function obligationFromEngine(
  tableId: string,
  handId: string,
  sequence: bigint,
  actionHash: string,
  o: EconomicObligation,
): Obligation {
  return {
    tableId,
    handId,
    sequence: sequence.toString(),
    actionHash,
    playerId: o.playerId,
    direction: o.kind === "PAY_TABLE" ? "PLAYER_TO_TABLE" : "TABLE_TO_PLAYER",
    amountShannons: o.amount.toString(),
    reason: o.reason,
    obligationId: o.obligationId,
  };
}

/** Notification emitted when a player-side payment is needed. */
export interface PaymentRequest {
  ref: SettlementRef;
  obligation: Obligation;
  paymentHash: string;
  /** Invoice address string when the backend produces one. */
  invoice?: string;
  /** rc7: payer needs the invoice ADDRESS for send_payment. */
  invoiceAddress?: string;
}

export interface SettlementAdapter {
  readonly name: string;
  /**
   * Start fulfilling an obligation. Idempotent per obligationId: calling
   * twice with the same obligation returns the same ref.
   */
  reserveOrPay(obligation: Obligation): Promise<SettlementRef>;
  getStatus(ref: SettlementRef): Promise<SettlementStatus>;
  /**
   * For PLAYER_TO_TABLE obligations the player must actually move funds.
   * The adapter emits the request; the server forwards PAYMENT_REQUIRED to
   * the player's connection. ImmediateFiberSettlement resolves when the
   * invoice is observed paid; the FakeSettlementAdapter when released.
   */
  onPaymentRequest(handler: (req: PaymentRequest) => void): void;
  finalize?(ref: SettlementRef, resolution: unknown): Promise<void>;
  cancel?(ref: SettlementRef, reason: string): Promise<void>;
}

/** Deterministic correlation: obligation id -> payment hash. */
export function paymentHashFor(obligation: Obligation): string {
  return toHex(
    ckbHash(
      new TextEncoder().encode(
        `FIBER_POKER/OBLIGATION/V1:${obligation.tableId}:${obligation.handId}:${obligation.obligationId}`,
      ),
    ),
  );
}

/**
 * Hold-mode preimage: derived deterministically from the obligation so the
 * table can always settle its own held invoices, yet kept OUT of logs
 * (docs/07: no preimages in logs). Note: the payment hash of a hold invoice
 * is therefore H(preimage), NOT paymentHashFor(obligation); correlation is
 * carried by the obligationId in the event log / custom records.
 */
export function holdPreimageFor(obligation: Obligation): string {
  return toHex(
    ckbHash(
      new TextEncoder().encode(
        `FIBER_POKER/HOLD_PREIMAGE/V1:${obligation.tableId}:${obligation.handId}:${obligation.obligationId}`,
      ),
    ),
  );
}

/** payment_hash = H(preimage) for a hold obligation. */
export function holdInvoiceHashFor(obligation: Obligation): string {
  return toHex(ckbHash(new TextEncoder().encode(holdPreimageFor(obligation))));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
