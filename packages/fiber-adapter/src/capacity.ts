/**
 * Session capacity (roadmap P3 polish): rc7 has no post-open funding RPC
 * and the acceptor contributes little or no collateral, so channel capacity
 * must be PROVISIONED by the side that needs it — a player opens
 * player-funded capacity to pay bets; a table opens table-funded capacity
 * to pay payouts. Payments route across any channel with capacity, so the
 * check is aggregate over all ready channels to the peer.
 */

import type { FiberGateway } from "./gateway.ts";

export interface CapacityOptions {
  /** Minimum spendable capacity TOWARD the peer (shannons). */
  min: bigint;
  /** Funding for a compensating open when short. On rc7 roughly a quarter
   *  of the funding becomes spendable (occupied capacity + acceptor
   *  collateral), so size generously — 600 CKB yields ~150 CKB. */
  openFunding: bigint;
  /** How long to wait for a new channel to materialize. */
  timeoutMs?: number;
}

/**
 * Aggregate spendable capacity TOWARD `peer` across ready channels, from
 * the gateway node's own point of view (its `localBalance`): a payment to
 * the peer spends THIS node's side of the channel, regardless of which
 * side opened it.
 */
export async function capacityTo(gateway: FiberGateway, peer: string): Promise<bigint> {
  const channels = await gateway.listChannels();
  return channels
    .filter((c) => c.peerPubkey === peer && c.stateName === "ChannelReady")
    .reduce((a, c) => a + c.localBalance, 0n);
}

/**
 * Ensure the gateway's node holds at least `min` capacity toward `peer`,
 * opening one funded channel when short. Resolves with the capacity, or
 * throws if the open never materializes. Best-effort by design: callers
 * proceed on failure and surface the payment error themselves.
 */
export async function ensureCapacity(
  gateway: FiberGateway,
  peer: string,
  opts: CapacityOptions,
): Promise<bigint> {
  let cap = await capacityTo(gateway, peer);
  if (cap >= opts.min) return cap;
  await gateway.openChannel(peer, opts.openFunding);
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  for (;;) {
    cap = await capacityTo(gateway, peer);
    if (cap >= opts.min) return cap;
    if (Date.now() > deadline) {
      throw new Error(
        `capacity to ${peer.slice(0, 12)}… below ${opts.min}: have ${cap}`,
      );
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
}
