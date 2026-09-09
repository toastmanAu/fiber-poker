/**
 * RecoveryManager (docs/06): startup must
 *   1. load the latest snapshot,
 *   2. replay later events through the pure engine,
 *   3. reconcile non-final Fiber operations by stored correlation ids,
 *   4. restore timers,
 *   5. refuse new actions until recovery completes (RECOVERY_COMPLETE).
 */

import type { EventStore, SnapshotStore } from "@fiber-poker/persistence";
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
  ) {}

  /**
   * Rebuild runtime state from snapshot + event log. `timersToRestore`
   * receives the turn-timer events that were still pending.
   */
  async recover(
    runtime: TableRuntime,
    tableConfig: TableConfig,
    restoreTimer: (payload: { handId: string; sequence: string; actingSeat: number; deadlineUnixMs: number }) => void,
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
          // Non-final Fiber operation: ask the adapter what actually happened.
          // The obligation was persisted at SettlementPlanned; recovery looks
          // it up by fiberRef and resolves exactly once.
          if (this.coordinator) {
            const planned = await this.findPlannedObligation(
              event.fiberRef ?? ((event.payload.fiberRef as string | undefined) ?? ""),
            );
            if (planned) {
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
              reconciled += 1;
            }
          }
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
