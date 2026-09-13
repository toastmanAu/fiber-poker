/**
 * RecoveryManager (docs/06): startup must
 *   1. load the latest snapshot,
 *   2. replay later events through the pure engine,
 *   3. reconcile non-final Fiber operations by stored correlation ids,
 *   4. restore timers,
 *   5. refuse new actions until recovery completes (RECOVERY_COMPLETE).
 */

import type { EventStore, SnapshotStore } from "@fiber-poker/persistence";
import type { FiberGateway } from "@fiber-poker/fiber-adapter";
import type { TableRuntime } from "./runtime.ts";
import type { ChainTip } from "./runtime.ts";
import type { SettlementCoordinator } from "./coordinator.ts";
import { createTableState, type TableConfig, type TableState } from "@fiber-poker/poker-engine";
import { publicView, genesisStateHash } from "@fiber-poker/protocol";
import { parseState } from "./serde.ts";

export interface RecoveryResult {
  replayedEvents: number;
  fromSnapshot: boolean;
  reconciledInflight: number;
  timersRestored: number;
  stateHash: string;
}

export class RecoveryManager {
  constructor(
    private readonly events: EventStore,
    private readonly snapshots: SnapshotStore,
    private readonly coordinator: SettlementCoordinator | null,
    /**
     * Live reconciliation: a gateway-backed server passes its gateway so
     * non-final Fiber ops can be resolved against the NODE (the fresh
     * process has no in-memory adapter entries). Null (fake mode) keeps
     * the legacy in-process reconcile path.
     */
    private readonly gateway: FiberGateway | null = null,
    private readonly resolvePeer: (playerId: string) => string = (id) => id,
  ) {}

  /**
   * Rebuild runtime state from snapshot + event log. `timersToRestore`
   * receives the turn-timer events that were still pending.
   */
  async recover(
    runtime: TableRuntime,
    tableConfig: TableConfig,
    restoreTimer: (payload: { handId: string; sequence: string; actingSeat: number; deadlineUnixMs: number }) => void,
    restoreChannel?: (playerId: string, channelId: string) => void,
  ): Promise<RecoveryResult> {
    const snapshot = await this.snapshots.loadLatest();
    let fromEventId: string | undefined;
    let fromSnapshot = false;
    if (snapshot) {
      runtime.state = parseState(JSON.stringify(snapshot.state));
      runtime.tip = { sequence: BigInt(runtime.state.sequence), stateHash: snapshot.stateHash };
      fromEventId = snapshot.lastEventId;
      fromSnapshot = true;
    }

    const all = await this.events.readAll(fromEventId);
    let replayed = 0;
    let reconciled = 0;
    let timersRestored = 0;
    const timerStarts = new Map<string, { handId: string; sequence: string; actingSeat: number; deadlineUnixMs: number }>();
    /** Latest session->channel mapping per player (from ChannelReady events). */
    const channelByPlayer = new Map<string, string>();

    // Pass 1: which obligations already reached a recorded terminal outcome?
    // A PaymentInflight whose PaymentSucceeded/PaymentFailed is ALSO in the
    // log is history to replay, not an operation to reconcile.
    const finalized = new Set<string>();
    for (const event of all) {
      if (
        event.eventType === "PaymentSucceeded" ||
        event.eventType === "PaymentFailed" ||
        event.eventType === "PayoutSucceeded" ||
        event.eventType === "PayoutFailed"
      ) {
        const id = (event.payload as { obligationId?: string }).obligationId;
        if (id) finalized.add(id);
      }
    }

    for (const event of all) {
      replayed += 1;
      switch (event.eventType) {
        case "ActionCommitted": {
          runtime.replayEvent(
            event.payload as { action: unknown; actionHash: string },
            event.stateHash!,
          );
          break;
        }
        case "PaymentInflight":
        case "PayoutInflight": {
          // Non-final Fiber operation: ask what actually happened. With a
          // gateway (live mode) the NODE is the source of truth via the
          // persisted payment hash; without one (fake mode) the shared
          // in-process adapter is.
          const p = event.payload as { obligationId?: string; paymentHash?: string; direction?: string };
          if (p.obligationId && finalized.has(p.obligationId)) break; // already final
          const planned = await this.findPlannedObligation(
            event.fiberRef ?? ((event.payload.fiberRef as string | undefined) ?? ""),
          );
          if (!planned) break;
          if (this.gateway && p.paymentHash) {
            await this.reconcileAgainstNode(event, planned.obligation, p);
          } else if (this.coordinator) {
            const outcome = await this.coordinator.reconcile(planned.obligation, {
              adapter: "unknown",
              id: event.fiberRef ?? "",
            });
            await this.events.append({
              tableId: event.tableId,
              handId: event.handId ?? null,
              sequence: event.sequence ?? null,
              eventType: outcome === "SETTLED" ? "PaymentSucceeded" : "PaymentFailed",
              createdAt: new Date().toISOString(),
              payload: { recovery: true, obligationId: planned.obligation.obligationId },
              fiberRef: event.fiberRef ?? null,
            });
          }
          reconciled += 1;
          break;
        }
        case "TurnTimerStarted": {
          const p = event.payload as { handId: string; sequence: string; actingSeat: number; deadlineUnixMs: number };
          timerStarts.set(`${p.handId}:${p.sequence}`, p);
          break;
        }
        case "TurnTimeoutResolved": {
          const p = event.payload as { handId: string; sequence: string };
          timerStarts.delete(`${p.handId}:${p.sequence}`);
          break;
        }
        case "ChannelReady": {
          const p = event.payload as { playerId?: string; channelId?: string };
          if (p.playerId && p.channelId) channelByPlayer.set(p.playerId, p.channelId);
          break;
        }
        default:
          break;
      }
    }

    // Restore only timers that are still relevant (acting seat unchanged).
    for (const t of timerStarts.values()) {
      if (runtime.state.actingSeat === t.actingSeat && runtime.state.handId === t.handId) {
        restoreTimer(t);
        timersRestored += 1;
      }
    }

    // Re-arm the channel bookkeeping for everyone still seated: without it
    // the restarted server pays out leaves but never closes the real
    // channel (empty session->channel map).
    if (restoreChannel) {
      for (const seat of runtime.state.seats) {
        if (!seat.playerId) continue;
        const channelId = channelByPlayer.get(seat.playerId);
        if (channelId) restoreChannel(seat.playerId, channelId);
      }
    }

    await this.events.append({
      tableId: runtime.state.tableId,
      handId: null,
      sequence: null,
      eventType: "RecoveryCompleted",
      createdAt: new Date().toISOString(),
      payload: { replayedEvents: replayed, fromSnapshot, reconciled, timersRestored },
      stateHash: runtime.tip.stateHash,
      fiberRef: null,
    });

    return {
      replayedEvents: replayed,
      fromSnapshot,
      reconciledInflight: reconciled,
      timersRestored,
      stateHash: runtime.tip.stateHash,
    };
  }

  /**
   * Resolve one non-final operation against the live Fiber node and record
   * the outcome as durable evidence. Player-protection policy: money that
   * REACHED the table for an action that never committed is refunded
   * immediately over the channel (keysend) and logged.
   */
  private async reconcileAgainstNode(
    event: import("@fiber-poker/persistence").PokerEvent,
    obligation: import("@fiber-poker/settlement").Obligation,
    payload: { obligationId?: string; paymentHash?: string; direction?: string },
  ): Promise<void> {
    const hash = payload.paymentHash!;
    const playerToTable = (payload.direction ?? obligation.direction) === "PLAYER_TO_TABLE";
    let settled: boolean;
    let note = "";
    try {
      if (playerToTable) {
        const status = await this.gateway!.invoiceStatus(hash);
        if (status === "Paid") {
          // Collected but never committed: refund before anything else.
          try {
            const refund = await this.gateway!.sendToPeer(
              this.resolvePeer(obligation.playerId),
              BigInt(obligation.amountShannons),
            );
            note = `refunded-on-recovery:${refund.paymentHash.slice(0, 14)}…`;
          } catch (e) {
            note = `REFUND_FAILED:${String(e)}`;
          }
          settled = false;
        } else if (status === "Received") {
          // Locked but not final: cancel returns the funds to the player.
          await this.gateway!.cancelInvoice?.(hash);
          note = "cancelled-on-recovery:was-held";
          settled = false;
        } else {
          // Open (never paid), Cancelled, Expired, Unknown: nothing to make
          // right — the action simply never committed.
          if (status === "Open") await this.gateway!.cancelInvoice?.(hash);
          settled = false;
          note = `invoice:${status}`;
        }
      } else {
        const status = await this.gateway!.paymentStatus(hash);
        settled = status === "Success";
        note = `payout:${status}`;
      }
    } catch (e) {
      settled = false;
      note = `probe-failed:${String(e)}`;
    }
    await this.events.append({
      tableId: event.tableId,
      handId: event.handId ?? null,
      sequence: event.sequence ?? null,
      eventType: settled
        ? (playerToTable ? "PaymentSucceeded" : "PayoutSucceeded")
        : (playerToTable ? "PaymentFailed" : "PayoutFailed"),
      createdAt: new Date().toISOString(),
      payload: { recovery: true, obligationId: obligation.obligationId, paymentHash: hash, note },
      fiberRef: event.fiberRef ?? null,
    });
  }

  private async findPlannedObligation(
    fiberRef: string,
  ): Promise<{ obligation: import("@fiber-poker/settlement").Obligation } | null> {
    if (!fiberRef) return null;
    const planned = await this.events.readByFiberRef(fiberRef);
    for (const e of planned) {
      if (e.eventType === "SettlementPlanned" && e.payload?.obligation) {
        return { obligation: e.payload.obligation as import("@fiber-poker/settlement").Obligation };
      }
    }
    return null;
  }
}

/**
 * Build the initial (genesis) runtime state + tip.
 */
export function genesisRuntime(
  tableId: string,
  config: TableConfig,
): { state: TableState; tip: ChainTipShape } {
  const state = createTableState(tableId, config);
  const tip = { sequence: 0n, stateHash: genesisStateHash(publicView(state)) };
  return { state, tip };
}

interface ChainTipShape {
  sequence: bigint;
  stateHash: string;
}
