/**
 * FakeSettlementAdapter: fast, deterministic settlement for CI and dev
 * (handoff docs/09 section 4). Injects every failure mode the real adapter
 * can produce and lets tests release payments manually or automatically.
 *
 * Fault modes per obligation id (or global default):
 *   - success          resolve SUCCEEDED after `resolveAfter` ticks
 *   - permanent-fail   FAILED on first poll
 *   - transient        fail N times, then succeed (retry path)
 *   - late-success     succeed only after `release` is called (payment stuck)
 *   - timeout          stay INFLIGHT forever
 */

import {
  paymentHashFor,
  type Obligation,
  type PaymentRequest,
  type SettlementAdapter,
  type SettlementRef,
  type SettlementStatus,
} from "./types.ts";

export type FaultMode = "success" | "permanent-fail" | "transient" | "late-success" | "timeout";

interface Entry {
  ref: SettlementRef;
  obligation: Obligation;
  paymentHash: string;
  status: SettlementStatus;
  mode: FaultMode;
  remainingFailures: number;
  ticksUntilSuccess: number;
  attempts: number;
  error?: string;
}

export class FakeSettlementAdapter implements SettlementAdapter {
  readonly name = "fake-settlement";
  /** Entries keyed by ref.id; obligationId maps to the latest entry. */
  private entries = new Map<string, Entry>();
  private byObligation = new Map<string, Entry>();
  private faults = new Map<string, { mode: FaultMode; failuresLeft?: number }>();
  /** Prefix currently matching an entry (to consume budget on its poll). */
  private entryFaultPrefix = new Map<string, string>();
  private paymentHandlers = new Set<(req: PaymentRequest) => void>();
  /** Global default mode (used when no per-obligation fault set). */
  defaultMode: FaultMode = "success";
  /** When true, PLAYER_TO_TABLE requests resolve automatically (dev/demo). */
  autoPayPlayerPayments = true;

  onPaymentRequest(handler: (req: PaymentRequest) => void): void {
    this.paymentHandlers.add(handler);
  }

  /** Schedule a fault for obligations matching an id prefix ("hand-3:…").
   *  For "transient", `failures` is a global budget consumed across retries. */
  setFault(obligationIdPrefix: string, mode: FaultMode, failures = 1): void {
    this.faults.set(obligationIdPrefix, { mode, failuresLeft: failures });
  }

  private modeFor(obligationId: string): { mode: FaultMode; failuresLeft: number | null } {
    for (const [prefix, f] of this.faults) {
      if (obligationId.startsWith(prefix)) {
        return { mode: f.mode, failuresLeft: f.failuresLeft ?? null };
      }
    }
    return { mode: this.defaultMode, failuresLeft: null };
  }

  private consumeFailure(faultKey: string, failuresLeft: number | null): boolean {
    // Returns true if a failure should still be injected.
    if (failuresLeft === null) return true;
    const f = this.faults.get(faultKey)!;
    if ((f.failuresLeft ?? 0) > 0) {
      f.failuresLeft = (f.failuresLeft ?? 0) - 1;
      return true;
    }
    return false;
  }

  async reserveOrPay(obligation: Obligation): Promise<SettlementRef> {
    const existing = this.entries.get(obligation.obligationId);
    if (existing && existing.status !== "FAILED" && existing.status !== "CANCELLED") {
      return existing.ref; // idempotent — never duplicate a live payment
    }
    // Terminal failure: a retry is a NEW attempt (new ref), still keyed by
    // obligationId so success remains exactly-once.
    const attempts = (existing?.attempts ?? 0) + 1;
    const { mode, failuresLeft } = this.modeFor(obligation.obligationId);
    const ref: SettlementRef = { adapter: this.name, id: `${obligation.obligationId}#${attempts}` };
    const entry: Entry = {
      ref,
      obligation,
      paymentHash: paymentHashFor(obligation),
      status: "INFLIGHT",
      mode,
      remainingFailures: failuresLeft ?? 0,
      ticksUntilSuccess: 0,
      attempts,
    };
    this.entries.set(ref.id, entry);
    this.byObligation.set(obligation.obligationId, entry);
    // Remember which fault rule governs this obligation for budget consume.
    for (const prefix of this.faults.keys()) {
      if (obligation.obligationId.startsWith(prefix)) this.entryFaultPrefix.set(obligation.obligationId, prefix);
    }

    if (obligation.direction === "PLAYER_TO_TABLE") {
      const req: PaymentRequest = { ref, obligation, paymentHash: entry.paymentHash };
      for (const handler of this.paymentHandlers) handler(req);
      if (this.autoPayPlayerPayments) {
        this.playerPaid(obligation.obligationId);
      }
    } else {
      // TABLE_TO_PLAYER: the table itself is the payer, so the fake resolves
      // immediately except under injected faults.
      this.resolveOnPoll(entry);
    }
    return ref;
  }

  /** Simulate the player's node paying an invoice (manual mode). */
  playerPaid(obligationId: string): void {
    const entry = this.byObligation.get(obligationId);
    if (entry && entry.status === "INFLIGHT") {
      this.resolveOnPoll(entry);
    }
  }

  /** Advance fake time / settlement state by one tick. */
  tick(): void {
    for (const entry of this.byObligation.values()) {
      if (entry.status === "INFLIGHT" && entry.mode === "success" && entry.ticksUntilSuccess > 0) {
        entry.ticksUntilSuccess -= 1;
        if (entry.ticksUntilSuccess === 0) entry.status = "SUCCEEDED";
      }
    }
  }

  private resolveOnPoll(entry: Entry): void {
    switch (entry.mode) {
      case "success":
        entry.status = "SUCCEEDED";
        break;
      case "permanent-fail":
        entry.status = "FAILED";
        entry.error = "injected permanent failure";
        break;
      case "transient": {
        const prefix = this.entryFaultPrefix.get(entry.obligation.obligationId);
        const shouldFail = prefix ? this.consumeFailure(prefix, 0) : false;
        if (shouldFail) {
          entry.status = "FAILED";
          entry.error = "injected transient failure";
        } else {
          entry.status = "SUCCEEDED";
        }
        break;
      }
      case "late-success":
      case "timeout":
        // stay INFLIGHT until release()/forever
        break;
    }
  }

  /** Manually release a stuck (late-success) payment. */
  release(obligationId: string): void {
    const entry = this.byObligation.get(obligationId);
    if (entry && entry.status === "INFLIGHT") entry.status = "SUCCEEDED";
  }

  fail(obligationId: string, reason: string): void {
    const entry = this.byObligation.get(obligationId);
    if (entry && entry.status !== "SUCCEEDED") {
      entry.status = "FAILED";
      entry.error = reason;
    }
  }

  async getStatus(ref: SettlementRef): Promise<SettlementStatus> {
    return this.entries.get(ref.id)?.status ?? "PLANNED";
  }

  async cancel(ref: SettlementRef, reason: string): Promise<void> {
    const entry = this.entries.get(ref.id); // keyed by ref id

    if (entry && (entry.status === "INFLIGHT" || entry.status === "HELD" || entry.status === "PLANNED")) {
      entry.status = "CANCELLED";
      entry.error = reason;
    }
  }

  /** Test introspection. */
  entryFor(obligationId: string): Entry | undefined {
    return this.byObligation.get(obligationId);
  }
  allEntries(): Entry[] {
    return [...this.byObligation.values()];
  }
}
