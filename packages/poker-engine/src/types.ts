/**
 * Core engine types. Aligned with the handoff contract in
 * fiber-poker-agent-handoff/interfaces/poker.ts, extended with the fields the
 * authoritative server needs (deck handling, acted flags, config).
 *
 * All money is integer shannons (bigint). No floats anywhere.
 */

export type Shannon = bigint;
export type PlayerId = string;
export type TableId = string;
export type HandId = string;

export const PROTOCOL_VERSION = 1;
export const MAX_SEATS = 6;

export type Street = "PREFLOP" | "FLOP" | "TURN" | "RIVER" | "SHOWDOWN";

export type Phase =
  | "WAITING"
  | "HAND_SETUP"
  | "POST_SMALL_BLIND"
  | "POST_BIG_BLIND"
  | "PREFLOP"
  | "FLOP"
  | "TURN"
  | "RIVER"
  | "SHOWDOWN"
  | "SETTLEMENT"
  | "HAND_COMPLETE";

export interface SeatState {
  seat: number;
  playerId: PlayerId | null;
  fiberPubkey: string | null;
  stack: Shannon;
  /** Chips pushed toward the pot on the current betting street. */
  streetContribution: Shannon;
  /** Chips committed to pots during the entire hand (sums all streets). */
  handContribution: Shannon;
  folded: boolean;
  allIn: boolean;
  sittingOut: boolean;
  /** Has this seat completed a voluntary action (or posted a blind) on the current street? */
  actedThisStreet: boolean;
  /** Private hole cards. Empty unless dealt in. Redacted from the canonical public view. */
  holeCards: number[];
}

export interface PotState {
  potId: number;
  amount: Shannon;
  eligiblePlayerIds: PlayerId[];
}

export interface TableConfig {
  smallBlind: Shannon;
  bigBlind: Shannon;
  maxSeats: number;
}

export interface TableState {
  protocolVersion: number;
  tableId: TableId;
  /** Immutable per-table configuration (blinds, seat count). */
  config: TableConfig;
  handId: HandId;
  /** Monotonic hand counter within the table (0 = no hand played yet). */
  handNo: number;
  sequence: bigint;
  previousStateHash: string;
  phase: Phase;
  street?: Street;
  buttonSeat?: number;
  smallBlindSeat?: number;
  bigBlindSeat?: number;
  actingSeat?: number;
  /** Highest streetContribution on the current street. */
  currentBet: Shannon;
  /** Size of the last full raise; the minimum increment for a full raise. */
  minimumRaise: Shannon;
  /** True when the most recent raise was a full raise (reopens betting). */
  lastRaiseWasFull: boolean;
  board: number[];
  /** Undealt cards for the current hand. Private; redacted from public views. */
  deck: number[];
  deckCommitment?: string;
  seats: SeatState[];
  pots: PotState[];
  /** Deterministic awards produced on entering SETTLEMENT. */
  awards: Award[];
  /** True when the hand aborted before becoming live (blind payment failed). */
  aborted?: boolean;
  abortReason?: string;
}

export type PokerActionType =
  | "SIT_DOWN"
  | "SIT_IN"
  | "SIT_OUT"
  | "STAND_UP"
  | "TOP_UP"
  | "START_HAND"
  | "POST_BLIND"
  | "CHECK"
  | "CALL"
  | "BET"
  | "RAISE"
  | "FOLD"
  | "ALL_IN"
  | "TIMEOUT_CHECK"
  | "TIMEOUT_FOLD"
  | "DISTRIBUTE_POTS"
  | "ABORT_HAND";

export type PokerAction =
  | { type: "SIT_DOWN"; playerId: PlayerId; fiberPubkey: string; seat: number; buyIn: Shannon }
  | { type: "SIT_IN"; playerId: PlayerId }
  | { type: "SIT_OUT"; playerId: PlayerId }
  | { type: "STAND_UP"; playerId: PlayerId }
  | { type: "TOP_UP"; playerId: PlayerId; amount: Shannon }
  | {
      type: "START_HAND";
      handId: HandId;
      /** Complete shuffled deck in draw order. Engine consumes, never generates. */
      deck: number[];
      deckCommitment: string;
    }
  | { type: "POST_BLIND"; playerId: PlayerId }
  | { type: "CHECK"; playerId: PlayerId }
  | { type: "CALL"; playerId: PlayerId }
  | { type: "BET"; playerId: PlayerId; amount: Shannon }
  | { type: "RAISE"; playerId: PlayerId; amount: Shannon }
  | { type: "FOLD"; playerId: PlayerId }
  | { type: "ALL_IN"; playerId: PlayerId }
  | { type: "TIMEOUT_CHECK"; playerId: PlayerId }
  | { type: "TIMEOUT_FOLD"; playerId: PlayerId }
  | { type: "DISTRIBUTE_POTS" }
  | { type: "ABORT_HAND"; reason: string };

export type ObligationReason = "SMALL_BLIND" | "BIG_BLIND" | "CALL" | "BET" | "RAISE" | "TOP_UP" | "PAYOUT" | "REFUND";

export interface EconomicObligation {
  kind: "PAY_TABLE" | "PAY_PLAYER";
  playerId: PlayerId;
  amount: Shannon;
  reason: ObligationReason;
  potId?: number;
  /** Deterministic id for dedup: `${handId}:${sequence}:${reason}:${playerId}` */
  obligationId: string;
}

export interface Award {
  playerId: PlayerId;
  amount: Shannon;
  potIds: number[];
  oddChips: Shannon;
}

export interface PokerTransition {
  nextState: TableState;
  obligations: EconomicObligation[];
  /** Concise machine-readable description for events / client display. */
  summary: string;
}

export type PokerErrorCode =
  | "OUT_OF_TURN"
  | "NOT_SEATED"
  | "SEAT_TAKEN"
  | "TABLE_FULL"
  | "FOLDED"
  | "ALL_IN_SEAT"
  | "SITTING_OUT"
  | "ILLEGAL_CHECK"
  | "INSUFFICIENT_FUNDS"
  | "AMOUNT_TOO_SMALL"
  | "AMOUNT_TOO_LARGE"
  | "WRONG_PHASE"
  | "WRONG_BLIND_SEAT"
  | "ALREADY_IN_HAND"
  | "NOT_ENOUGH_PLAYERS"
  | "INVALID_AMOUNT"
  | "INVALID_DECK"
  | "POTS_NOT_SETTLED"
  | "PLAYER_ACTIVE_ELSEWHERE"
  | "NO_POTS";

export class PokerError extends Error {
  readonly code: PokerErrorCode;
  constructor(code: PokerErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type ReduceResult =
  | { ok: true; transition: PokerTransition }
  | { ok: false; error: PokerError };

export interface PokerEngine {
  reduce(state: TableState, action: PokerAction): ReduceResult;
}
