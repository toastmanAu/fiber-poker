# Devnet deployment guide

This guide brings up a production-like test topology: CKB devnet, table
FNN node, player FNN nodes, and a watchtower. Everything here uses
**devnet/testnet assets only**.

> Verify all RPC shapes against `docs/fnn-compat.md` and your pinned FNN
> build before relying on them. Occupied capacity on native-CKB channels is
> roughly 99 CKB per side (98 commitment lock + 1 shutdown fee allowance);
> never hard-code that figure without checking the pinned release.

## Topology

```
        P1
         |
P2 -- TABLE -- P3        one private bidirectional channel per seat
       / | \             (public: false, one_way: false)
     P4  P5 P6
```

Star topology, six channels. Full mesh (15 channels) is deliberately not
used: bilateral channels cannot express a contingent six-way pot.

## 1. CKB devnet

Use the [ckb-devnet](https://github.com/nervosnetwork/ckb-devnet) compose
file as the chain backend:

```bash
cd infra/ckb-devnet
docker compose up -d          # specs in docker-compose.yml.template
```

Mine a few blocks so the table wallet has devnet CKB (spec in
`miner.md.template`).

## 2. Table FNN node

```bash
cp infra/fnn/config.toml.template fnn-table.toml
# set node_name, listening addr, rpc url, and the devnet scripts dir
fnn -c fnn-table.toml
```

The table needs:

- RPC reachable from the table server process only (`FIBER_POKER_FNN_URL`);
- enough on-chain balance to fund six channels
  (`FIBER_POKER_CHANNEL_FUNDING` per seat, default 1000 CKB);
- a watchtower enabled (built-in or standalone — see §4).

Start the table server with real settlement:

```bash
FIBER_POKER_SETTLEMENT=fiber \
FIBER_POKER_FNN_URL=http://127.0.0.1:8227 \
FIBER_POKER_DATA_DIR=.data/table \
npm run server
```

The `ImmediateFiberSettlement` adapter then:

- creates invoices bound to deterministic obligation hashes
  (`new_invoice { amount, payment_hash }`) for player→table payments;
- sends keysend-style payouts (`send_payment { target_pubkey, amount,
  payment_hash }`) for table→player payouts;
- polls `get_invoice` / `get_payment` until terminal status.

## 3. Player nodes (devnet harness)

Each player runs an FNN node with its own wallet, connects to the table
multiaddr (`connect_peer`), and either opens the channel themselves
(`open_channel { peer_id: table, funding_amount, public: false,
one_way: false }`) or waits for the table to open and calls
`accept_channel`. Player agents pay invoices with `send_payment { invoice }`.

The browser client never talks to FNN directly. A player agent (small
Node process holding that player's FNN credentials) listens for
`PAYMENT_REQUIRED` and pays; the wire contract is in `docs/protocol.md`.

## 4. Watchtower

FNN v0.9.0 ships a watchtower RPC module (`create_watch_channel`,
`remove_watch_channel`, `update_revocation`, …) plus config knobs
(`disable_built_in_watchtower`, `standalone_watchtower_rpc_url`,
`standalone_watchtower_token`). Run:

- one standalone watchtower for the table's channels;
- per-player watchtower coverage (a hosted/standalone tower is the mobile
  story: phones sleep).

Template: `infra/watchtower/config.toml.template`.

## 5. Force close policy

- Cooperative shutdown (`shutdown_channel { channel_id }`) is the normal
  leave path after final payouts and with no pending TLCs.
- `shutdown_channel { force: true }` is recovery only: surface explicit
  status, block seat reuse until closure resolves, watch the chain until
  final.

## 6. Liquidity ops

- Pre-hand gate: table outbound per-channel ≥ player stack, else hands
  pause (`LiquidityManager`).
- Top-up: open an additional funded channel (splice-equivalent is future
  work) — currently an explicit operator action.
- Rebalancing: circular self-payment abstraction exists; not automated.
