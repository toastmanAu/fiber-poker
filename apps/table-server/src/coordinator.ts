/**
 * SettlementCoordinator: implements the payment-before-commit pipeline for
 * every value-changing transition (handoff docs/03, docs/06):
 *
 *   persist SettlementPlanned
 *     -> adapter.reserveOrPay   (Fiber side effect starts)
 *     -> persist PaymentInflight (fiberRef = payment hash)
 *     -> await terminal status   (player pays invoice / payout sends)
 *     -> persist PaymentSucceeded | PaymentFailed
 *     -> ONLY NOW may the poker transition commit
 *
 * Durable correlation: (tableId, handId, obligationId) <-> paymentHash lives
 * in the event log, so recovery can reconcile any non-final operation.
 */

import type { EconomicObligation } from "@fiber-poker/poker-engine";
import type { EventStore } from "@fiber-poker/persistence";
import {
  obligationFromEngine,
  type Obligation,
  type PaymentRequest,
  type SettlementAdapter,
  type SettlementRef,
} from "@fiber-poker/settlement";

export interface SettlementContext {
  handId: string;
  sequence: bigint;
  actionHash: string;
}

export type SettlementOutcome = "SETTLED" | "FAILED";

export class SettlementCoordinator {
  /** Obligations that never reached a terminal state (recovery interest). */
  readonly inflight = new Map<string, { obligation: Obligation; ref: SettlementRef }>();
  private retries: number;
  private retryDelayMs: number;

  constructor(
    private readonly adapter: SettlementAdapter,
    private readonly events: EventStore,
    private readonly notify: (playerId: string, message: unknown) => void,
    opts?: { retries?: number; retryDelayMs?: number },
  ) {
    this.retries = opts?.retries ?? 3;
    this.retryDelayMs = opts?.retryDelayMs ?? 250;
    this.adapter.onPaymentRequest((req) => this.onPaymentRequest(req));
  }

  private onPaymentRequest(req: PaymentRequest): void {
    this.notify(req.obligation.playerId, {
      type: "PAYMENT_REQUIRED",
      payload: {
        paymentHash: req.paymentHash,
        amountShannons: req.obligation.amountShannons,
        reason: req.obligation.reason,
        obligationId: req.obligation.obligationId,
        invoice: req.invoice,
        direction: req.obligation.direction,
      },
    });
  }

  /**
   * Fulfil every obligation; resolve SETTLED only when ALL have reached
   * SUCCEEDED. Any definitive FAILED (after retries) -> FAILED. Poker state
   * may only advance on SETTLED.
   */
  async fulfil(
    obligations: EconomicObligation[],
    ctx: SettlementContext,
  ): Promise<SettlementOutcome> {
    for (const o of obligations) {
      const obligation = obligationFromEngine(this.tableId(), ctx.handId, ctx.sequence, ctx.actionHash, o);
      const outcome = await this.fulfilOne(obligation);
      if (outcome !== "SETTLED") return "FAILED";
    }
    return "SETTLED";
  }

  private tableId(): string {
    return this._tableId ?? "unknown";
  }
  private _tableId?: string;
  setTableId(id: string): void {
    this._tableId = id;
  }

  private async fulfilOne(obligation: Obligation): Promise<SettlementOutcome> {
    // Persist intent BEFORE any Fiber side effect.
    await this.events.append({
      tableId: obligation.tableId,
      handId: obligation.handId || null,
      sequence: obligation.sequence,
      eventType: "SettlementPlanned",
      createdAt: new Date().toISOString(),
      payload: { obligation } as unknown as Record<string, unknown>,
      fiberRef: null,
    });

    let lastError = "";
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      const ref = await this.adapter.reserveOrPay(obligation);
      // Idempotent adapters return the original ref; record the correlation.
      await this.events.append({
        tableId: obligation.tableId,
        handId: obligation.handId || null,
        sequence: obligation.sequence,
        eventType: obligation.direction === "PLAYER_TO_TABLE" ? "PaymentInflight" : "PayoutInflight",
        createdAt: new Date().toISOString(),
        payload: {
          obligationId: obligation.obligationId,
          attempt,
          direction: obligation.direction,
          amountShannons: obligation.amountShannons,
        },
        fiberRef: ref.id,
      });
      this.inflight.set(obligation.obligationId, { obligation, ref });

      const status = await this.awaitTerminal(ref);
      if (status === "SUCCEEDED") {
        await this.events.append({
          tableId: obligation.tableId,
          handId: obligation.handId || null,
          sequence: obligation.sequence,
          eventType: obligation.direction === "PLAYER_TO_TABLE" ? "PaymentSucceeded" : "PayoutSucceeded",
          createdAt: new Date().toISOString(),
          payload: { obligationId: obligation.obligationId, attempt },
          fiberRef: ref.id,
        });
        this.inflight.delete(obligation.obligationId);
        return "SETTLED";
      }
      lastError = `attempt ${attempt}: ${status}`;
      await this.events.append({
        tableId: obligation.tableId,
        handId: obligation.handId || null,
        sequence: obligation.sequence,
        eventType: "PaymentFailed",
        createdAt: new Date().toISOString(),
        payload: { obligationId: obligation.obligationId, attempt, status },
        fiberRef: ref.id,
      });
      if (status === "CANCELLED") break;
      if (attempt < this.retries) await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
    }
    void lastError;
    return "FAILED";
  }

  private async awaitTerminal(ref: SettlementRef, timeoutMs = 120_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.adapter.getStatus(ref);
      if (status === "SUCCEEDED" || status === "FAILED" || status === "CANCELLED") return status;
      if (Date.now() > deadline) {
        await this.adapter.cancel?.(ref, "coordinator timeout");
        return "FAILED";
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Reconciliation hook for recovery: resolve a pending operation by ref. */
  async reconcile(obligation: Obligation, ref: SettlementRef): Promise<SettlementOutcome> {
    const status = await this.awaitTerminal(ref, 30_000);
    return status === "SUCCEEDED" ? "SETTLED" : "FAILED";
  }
}
