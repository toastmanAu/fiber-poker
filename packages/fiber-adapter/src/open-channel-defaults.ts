/**
 * Funding-amount policy for channel opens (roadmap P2).
 *
 * Live-learned rules (docs/fnn-compat.md):
 *   - Below 99 CKB the INITIATOR's on-chain reserve leaves nothing
 *     spendable in the channel — useless regardless of the peer.
 *   - Under the PEER's auto-accept minimum the open is pinned in
 *     NegotiatingFunding FOREVER with no rejection (a ghost channel);
 *     the floor is gossiped via
 *     `graph_nodes[].auto_accept_min_ckb_funding_amount`.
 *
 * classifyFundingAmount turns a requested amount into a verdict: open as
 * asked, hard-block (below reserve), or bump to the peer's floor (which
 * rc7 auto-accepts exactly at the minimum).
 */

export const SHANNONS_PER_CKB = 100_000_000n;
/** Initiator reserve: opens under this can never spend. */
export const INITIATOR_RESERVE = 99n * SHANNONS_PER_CKB;
/** Hard floor we never open under: the reserve plus 1 CKB of headroom. */
export const MIN_VIABLE_FUNDING = 100n * SHANNONS_PER_CKB;

export type FundingVerdict =
  | { verdict: "ok"; openAmount: bigint; requested: bigint }
  | { verdict: "below-reserve"; openAmount: bigint; requested: bigint; detail: string }
  | { verdict: "bumped-to-peer-floor"; openAmount: bigint; requested: bigint; peerFloor: bigint };

export function classifyFundingAmount(requested: bigint, peerFloor?: bigint): FundingVerdict {
  if (requested < MIN_VIABLE_FUNDING) {
    return {
      verdict: "below-reserve",
      openAmount: requested,
      requested,
      detail: `funding ${requested} shannons is below the hard floor of ${MIN_VIABLE_FUNDING} (99 CKB initiator reserve + 1 CKB headroom); the channel could never spend`,
    };
  }
  if (peerFloor !== undefined && requested < peerFloor) {
    // Below the peer's auto-accept minimum rc7 pins the open in
    // NegotiatingFunding forever. Open AT the floor instead — rc7
    // auto-accepts exactly at the minimum.
    return { verdict: "bumped-to-peer-floor", openAmount: peerFloor, requested, peerFloor };
  }
  return { verdict: "ok", openAmount: requested, requested };
}
