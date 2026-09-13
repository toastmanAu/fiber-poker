/**
 * Live-topology helper shared by the gated live suites.
 *
 * rc7 has no post-open funding RPC: channel capacity comes only from the
 * opener's funding — empirically the acceptor contributes ZERO collateral
 * on this testnet (auto-accept takes no funds from its wallet). Consequence:
 *   - a TABLE-funded channel has no player-side balance, so the player can
 *     never pay an invoice over it;
 *   - a PLAYER-funded channel has no table-side balance, so the table can
 *     not pay stacks back out (the liquidity gate refuses joins).
 * A session therefore needs BOTH directions covered: at least one channel
 * with player-side capacity (bets) and at least one with table-side
 * capacity (payouts). Two opposite-directed channels are a valid topology —
 * fnn routes keysend/invoice payments across any channel with capacity.
 */

import type { RealFiberGateway } from "@fiber-poker/fiber-adapter";

export interface SessionCapacityOptions {
  /** Player-side capacity required (bets, buy-ins) in shannons. */
  minPlayerSide: bigint;
  /** Table-side capacity required (payouts) in shannons. */
  minTableSide: bigint;
  /** Funding for a compensating open when a direction is short. */
  openFunding: bigint;
}

/**
 * Ensure at least one ChannelReady channel to the table carries player-side
 * capacity AND at least one carries table-side capacity, opening
 * player- or table-funded channels as needed. Both opens poll until the
 * channel materializes (funding tx confirmed on testnet).
 */
export async function ensureSessionCapacity(
  tableGateway: RealFiberGateway,
  playerGateway: RealFiberGateway,
  opts: SessionCapacityOptions,
): Promise<void> {
  const tablePeer = await tableGateway.nodePubkey();
  const playerPeer = await playerGateway.nodePubkey();

  const directions = async (): Promise<{ player: boolean; table: boolean }> => {
    const channels = await tableGateway.listChannels();
    const mine = channels.filter((c) => c.peerPubkey === playerPeer && c.stateName === "ChannelReady");
    return {
      player: mine.some((c) => c.remoteBalance >= opts.minPlayerSide),
      table: mine.some((c) => c.localBalance >= opts.minTableSide),
    };
  };

  let have = await directions();
  if (!have.player) {
    await playerGateway.openChannel(tablePeer, opts.openFunding);
    await waitFor(() => directions().then((d) => d.player));
    have = await directions();
  }
  if (!have.table) {
    await tableGateway.openChannel(playerPeer, opts.openFunding);
    await waitFor(() => directions().then((d) => d.table));
    have = await directions();
  }

  async function waitFor(check: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (await check()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  if (!have.player || !have.table) {
    throw new Error(`session capacity not established: player-side ${have.player}, table-side ${have.table}`);
  }
}
