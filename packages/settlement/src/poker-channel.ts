/**
 * P12 RESEARCH PROTOTYPE: generalized CKB poker state channel (docs/14).
 *
 * A simulated adjudicator ("chain") plus the off-chain channel machinery
 * that docs/14 specifies:
 *
 *   PokerChannelState {
 *     protocolVersion, tableEpoch, participantSet[], balances[],
 *     gameStateHash, sequence, finalized
 *   }
 *
 * Enforcement model (docs/14's simpler variant): the chain verifies
 * signatures, sequence monotonicity, and balance CONSERVATION; the clients
 * independently verify poker rules before co-signing. The chain does not
 * execute Texas Hold'em.
 *
 * RESEARCH GRADE: the "chain" is an in-process simulator — no CKB scripts,
 * no dispute windows with real time, no cells. It demonstrates the state
 * machine and dispute semantics precisely enough to design against, and it
 * stays OUT of the live settlement path (FutureStateChannelSettlement still
 * refuses to run real money through it).
 */

import { CanonicalWriter, ckbHash, signHash, verifyHash } from "@fiber-poker/protocol";

const DOMAIN_POKER_CHANNEL = "FIBER_POKER/POKER_CHANNEL/V1";

export interface PokerChannelState {
  protocolVersion: number;
  tableEpoch: number;
  participantSet: string[];
  /** playerId -> shannons (decimal-string keys not needed: use string keys). */
  balances: Record<string, string>;
  /** Hash of the off-chain poker state this allocation covers. */
  gameStateHash: string;
  sequence: number;
  finalized: boolean;
}

export interface SignedChannelState {
  state: PokerChannelState;
  /** playerId -> 128-hex signature over the canonical state. */
  signatures: Record<string, string>;
}

/** Canonical binary encoding of a channel state (field order frozen). */
export function encodeChannelState(state: PokerChannelState): Uint8Array {
  const w = new CanonicalWriter();
  w.domain(DOMAIN_POKER_CHANNEL);
  w.u32(state.protocolVersion);
  w.u64(BigInt(state.tableEpoch));
  w.stringArray([...state.participantSet].sort());
  const ids = Object.keys(state.balances).sort();
  w.u32(ids.length);
  for (const id of ids) {
    w.string(id);
    w.u64(BigInt(state.balances[id]!));
  }
  w.string(state.gameStateHash);
  w.u64(BigInt(state.sequence));
  w.bool(state.finalized);
  return w.finish();
}

/** Channel-state hash: what signatures and the "chain" commit to. */
export function channelStateHash(state: PokerChannelState): string {
  const h = ckbHash(encodeChannelState(state));
  let out = "";
  for (const b of h) out += b.toString(16).padStart(2, "0");
  return out;
}

/** A participant co-signs a channel state with their identity key. */
export function signChannelState(
  state: PokerChannelState,
  privateKey: string,
): string {
  return signHash(privateKey, ckbHash(encodeChannelState(state)));
}

export function verifyChannelStateSignature(
  state: PokerChannelState,
  playerId: string,
  signature: string,
  publicKey: string,
): boolean {
  return verifyHash(publicKey, ckbHash(encodeChannelState(state)), signature);
}

export interface EpochConfig {
  epoch: number;
  participants: { playerId: string; publicKey: string; buyIn: bigint }[];
}

export interface DisputeRecord {
  channelId: string;
  submittedSequence: number;
  accepted: boolean;
  reason: string;
}

/**
 * Simulated generalized poker channel: off-chain co-signed allocations plus
 * an on-chain-style adjudicator for disputes.
 */
export class PokerChannelSim {
  private readonly publicKeys = new Map<string, string>();
  private latest: SignedChannelState | null = null;
  private epochTotal: bigint = 0n;
  private readonly disputes: DisputeRecord[] = [];
  private epochCounter = 0;

  /** Off-chain keys used for co-signing in this simulation. */
  private readonly keys = new Map<string, string>();

  /** Register a participant's signing keypair for the simulation. */
  addParticipant(playerId: string, publicKey: string, privateKey: string): void {
    this.publicKeys.set(playerId, publicKey);
    this.keys.set(playerId, privateKey);
  }

  latestState(): SignedChannelState | null {
    return this.latest;
  }

  disputeLog(): readonly DisputeRecord[] {
    return this.disputes;
  }

  /**
   * Open an epoch: buy-ins are "locked" into the shared allocation.
   * Every participant co-signs the initial state.
   */
  openEpoch(): SignedChannelState {
    if (this.latest && !this.latest.state.finalized) {
      throw new Error("previous epoch not finalized");
    }
    const participants = [...this.publicKeys.keys()];
    if (participants.length < 2) throw new Error("an epoch needs at least 2 participants");
    const balances: Record<string, string> = {};
    let total = 0n;
    for (const p of participants) {
      const buyIn = this.buyIns.get(p);
      if (buyIn === undefined) throw new Error(`no buy-in registered for ${p}`);
      balances[p] = buyIn.toString();
      total += buyIn;
    }
    this.epochTotal = total;
    const state: PokerChannelState = {
      protocolVersion: 1,
      tableEpoch: ++this.epochCounter,
      participantSet: participants,
      balances,
      gameStateHash: "0".repeat(64),
      sequence: 0,
      finalized: false,
    };
    this.latest = this.coSign(state);
    return this.latest;
  }

  private buyIns = new Map<string, bigint>();

  withBuyIn(playerId: string, amount: bigint): this {
    this.buyIns.set(playerId, amount);
    return this;
  }

  /**
   * Apply a hand result off-chain: balances move between participants with
   * strict conservation; every participant co-signs the new allocation.
   * `gameStateHash` binds the allocation to the poker state it settles.
   */
  applyHandResult(handId: string, gameStateHash: string, newBalances: Record<string, bigint>): SignedChannelState {
    const current = this.requireLatest();
    if (current.state.finalized) throw new Error("epoch finalized");
    const before = Object.values(current.state.balances).reduce((a, v) => a + BigInt(v), 0n);
    const after = Object.values(newBalances).reduce((a, v) => a + v, 0n);
    if (after !== before) {
      throw new Error(`conservation violated: ${after} != ${before} (hand ${handId})`);
    }
    for (const p of current.state.participantSet) {
      if (!(p in newBalances)) throw new Error(`missing balance for ${p}`);
    }
    const state: PokerChannelState = {
      ...current.state,
      balances: Object.fromEntries(Object.entries(newBalances).map(([k, v]) => [k, v.toString()])),
      gameStateHash,
      sequence: current.state.sequence + 1,
    };
    this.latest = this.coSign(state);
    return this.latest;
  }

  /**
   * THE CHAIN (simulated adjudicator): verify signatures, sequence, and
   * conservation, then accept or reject a submitted state. Used by disputes
   * and finalization. A STALE submission (sequence below the adjudicator's
   * accepted latest) is rejected — the honest challenge path supersedes it.
   */
  adjudicate(submitted: SignedChannelState): { accepted: boolean; reason: string } {
    const state = submitted.state;
    // 1. Every participant co-signed.
    for (const p of state.participantSet) {
      const sig = submitted.signatures[p];
      const pub = this.publicKeys.get(p);
      if (!sig || !pub || !verifyChannelStateSignature(state, p, sig, pub)) {
        const record = { channelId: `epoch-${state.tableEpoch}`, submittedSequence: state.sequence, accepted: false, reason: `missing/invalid signature from ${p}` };
        this.disputes.push(record);
        return { accepted: false, reason: record.reason };
      }
    }
    // 2. Conservation.
    const total = Object.values(state.balances).reduce((a, v) => a + BigInt(v), 0n);
    if (total !== this.epochTotal) {
      const record = { channelId: `epoch-${state.tableEpoch}`, submittedSequence: state.sequence, accepted: false, reason: `conservation violated (${total} != ${this.epochTotal})` };
      this.disputes.push(record);
      return { accepted: false, reason: record.reason };
    }
    // 3. Sequence monotonicity vs the adjudicator's accepted latest.
    const latestSeq = this.latest?.state.sequence ?? -1;
    if (state.sequence < latestSeq) {
      const record = { channelId: `epoch-${state.tableEpoch}`, submittedSequence: state.sequence, accepted: false, reason: `stale state (${state.sequence} < ${latestSeq})` };
      this.disputes.push(record);
      return { accepted: false, reason: record.reason };
    }
    this.latest = submitted;
    const record = { channelId: `epoch-${state.tableEpoch}`, submittedSequence: state.sequence, accepted: true, reason: "valid co-signed state" };
    this.disputes.push(record);
    return { accepted: true, reason: record.reason };
  }

  /**
   * Close an epoch: the latest allocation is finalized and balances pay out
   * of the shared escrow. Membership changes happen only between epochs.
   */
  finalizeEpoch(): SignedChannelState & { payouts: Record<string, bigint> } {
    const current = this.requireLatest();
    if (current.state.finalized) throw new Error("already finalized");
    const finalState: PokerChannelState = { ...current.state, finalized: true, sequence: current.state.sequence + 1 };
    const finalized = this.coSign(finalState);
    this.latest = finalized;
    const payouts = Object.fromEntries(Object.entries(finalState.balances).map(([k, v]) => [k, BigInt(v)]));
    return { ...finalized, payouts };
  }

  private coSign(state: PokerChannelState): SignedChannelState {
    const signatures: Record<string, string> = {};
    for (const p of state.participantSet) {
      const key = this.keys.get(p);
      if (!key) throw new Error(`no signing key registered for ${p}`);
      signatures[p] = signChannelState(state, key);
    }
    return { state, signatures };
  }

  private requireLatest(): SignedChannelState {
    if (!this.latest) throw new Error("epoch not open");
    return this.latest;
  }
}
