# Nervos Fiber Network Node (FNN) v0.9.0 — RPC API Compatibility Note

Status: verified against FNN tag `v0.9.0` (commit `e6cb7ac`, released 2025-08-06).
Audience: developers integrating directly against the FNN JSON-RPC API (e.g. a poker/game backend settling over native-CKB payment channels).

---

## Verified against (primary sources)

| Source | URL |
|---|---|
| v0.9.0 release notes | https://github.com/nervosnetwork/fiber/releases/tag/v0.9.0 |
| FNN README (repo root) | https://github.com/nervosnetwork/fiber |
| **RPC reference (generated, authoritative)** | https://raw.githubusercontent.com/nervosnetwork/fiber/v0.9.0/crates/fiber-lib/src/rpc/README.md |
| RPC JSON types — `ChannelState` / flags serialization | https://raw.githubusercontent.com/nervosnetwork/fiber/v0.9.0/crates/fiber-json-types/src/channel.rs |
| RPC JSON types — `PaymentStatus` | https://raw.githubusercontent.com/nervosnetwork/fiber/v0.9.0/crates/fiber-json-types/src/payment.rs |
| Flags serialization macro (`define_rpc_flags!`) | https://raw.githubusercontent.com/nervosnetwork/fiber/v0.9.0/crates/fiber-json-types/src/serde_utils.rs |
| Real e2e JSON-RPC requests (Bruno tests) | https://github.com/nervosnetwork/fiber/tree/v0.9.0/tests/bruno/e2e (`open-use-close-a-channel/`, `router-pay/`, `invoice-ops/`, `watchtower/`) |
| Public nodes manual (**99 CKB capacity figure + real `list_channels` response**) | https://raw.githubusercontent.com/nervosnetwork/fiber/v0.9.0/docs/public-nodes.md |
| Network nodes list (99 CKB collateral) | https://raw.githubusercontent.com/nervosnetwork/fiber/v0.9.0/docs/network-nodes.md |
| Example configs (ports, UDT whitelist, RPC modules) | https://raw.githubusercontent.com/nervosnetwork/fiber/v0.9.0/config/testnet/config.yml , `/config/mainnet/config.yml` |
| Biscuit RPC auth | https://raw.githubusercontent.com/nervosnetwork/fiber/v0.9.0/docs/biscuit-auth.md |
| WSS manual (P2P/browser transport, *not* RPC pub/sub) | https://raw.githubusercontent.com/nervosnetwork/fiber/v0.9.0/docs/fiber-node-wss.md |
| fiber-docs site API reference (cross-check) | https://github.com/nervosnetwork/fiber-docs — `content/docs/api-reference/**` (`channels/channel.mdx`, `payments/payment.mdx`, `payments/invoice.mdx`, `node/info.mdx`, `node/peer.mdx`, `types/types.mdx`) |
| simple-game example | https://github.com/nervosnetwork/fiber-docs/tree/master/example/simple-game — `src/fiber/index.ts`, `src/fiber/node.ts` |

Cross-checks performed: every field name below appears in **at least two** of (a) the generated RPC reference at tag `v0.9.0`, (b) the Rust serde types in `crates/fiber-json-types` at `v0.9.0`, (c) real e2e request/response JSON at `v0.9.0`, or (d) the fiber-docs API reference / simple-game example. Exceptions are flagged in "Could not verify".

---

## 1. Naming corrections (v0.9.0 exact names)

Older blog posts / the fiber-docs simple-game example use names that **do not exist in v0.9.0**:

| What you want | v0.9.0 method | Notes |
|---|---|---|
| Create an invoice | **`new_invoice`** | There is no `create_invoice`. |
| Send a payment for an invoice | **`send_payment`** with the `invoice` param | There is **no `send_invoice_payment`** method in v0.9.0. |
| Look up a payment | **`get_payment`** | Returns `GetPaymentCommandResult`. |
| Close a channel | **`shutdown_channel`** | There is no `close_channel`. Force close = `force: true`. |
| Channel detail | `list_channels` | No `get_channel` RPC exists. |
| Channel readiness | poll `list_channels`, check `state.state_name == "ChannelReady"` | No `channel_ready` / `is_ready` RPC. |
| Counterparty key field | `pubkey` | `peer_id` (pre-v0.7 docs) was renamed to `pubkey`. |
| Peer connection | `connect_peer` / `disconnect_peer` / `list_peers` | `list_peers` (not "list_connected_peers"). |

Full method inventory in v0.9.0 (module: methods):

- **Admin**: `backup`
- **Cch** (cross-chain hub): `send_btc`, `receive_btc`, `get_cch_order`
- **Channel**: `open_channel`, `accept_channel`, `abandon_channel`, `list_channels`, `shutdown_channel`, `update_channel`, `open_channel_with_external_funding`, `submit_signed_funding_tx`
- **Dev** (NOT available in release builds — dev-only): `commitment_signed`, `add_tlc`, `remove_tlc`, `submit_commitment_transaction`, `check_channel_shutdown`, `sign_external_funding_tx`
- **Graph**: `graph_nodes`, `graph_channels`
- **Info**: `node_info`
- **Invoice**: `new_invoice`, `parse_invoice`, `get_invoice`, `cancel_invoice`, `settle_invoice`
- **Payment**: `send_payment`, `get_payment`, `build_router`, `send_payment_with_router`, `list_payments`
- **Peer**: `connect_peer`, `disconnect_peer`, `list_peers`
- **Prof**: `pprof`
- **Watchtower**: `create_watch_channel`, `remove_watch_channel`, `update_revocation`, `update_pending_remote_settlement`, `update_local_settlement`, `create_preimage`, `remove_preimage`

---

## 2. Transport and encoding conventions

- **JSON-RPC 2.0 over HTTP POST**, single object body: `{"id": 42, "jsonrpc": "2.0", "method": "...", "params": [ { ...one params object... } ] }`. Note `params` is an **array containing exactly one object** (verified in all v0.9.0 e2e Bruno tests).
- Default endpoint: **`http://127.0.0.1:8227`** — config key `rpc.listening_addr` (testnet/mainnet sample configs and `docs/public-nodes.md` all use `127.0.0.1:8227`). P2P listen port is separate (`8228/tcp`).
- RPC auth: if `rpc.listening_addr` is public, `rpc.biscuit_public_key` is **required** (node refuses to start otherwise); clients then send `Authorization: Bearer <base64 biscuit token>`. On localhost no auth is needed. Optional `rpc.enabled_modules` can restrict modules (sample config lists `cch`, `channel`, `graph`, `payment`).
- Numbers: all `u64`/`u128` values (amounts, fee rates, timestamps, counts, TLC ids) are serialized as **`0x`-prefixed hex strings** in JSON (serde `U64Hex`/`U128Hex`). Inputs accept the same form.
- **Amount unit: shannons** for native CKB (1 CKB = 10^8 shannons = `0x2540be400`). `funding_amount: "0xba43b7400"` = 500 CKB. UDT amounts are in the token's base units. Docs explicitly say e.g. `send_payment.amount` is "the unit is Shannons for non UDT payment"; `fee_rate` default for shutdown is "1000 shannons/KW".
- `Hash256` (payment_hash, channel_id, tx_hash…): 32-byte `0x`-prefixed hex.
- `Pubkey`: **33-byte compressed secp256k1 hex, canonical form WITHOUT `0x` prefix** (e.g. `"02aa3beb..."`). Input deserializer accepts both prefixed and unprefixed; e2e tests send unprefixed for `target_pubkey`/`pubkey`.
- `Privkey` (watchtower methods): 32-byte hex, canonical form without `0x`.
- `Script` (CKB script): `{"code_hash": "0x...", "hash_type": "type"|"data"|"data1"|"data2", "args": "0x..."}`.
- Peer addresses are libp2p **multiaddr** strings, e.g. `"/ip4/54.179.226.154/tcp/8228/p2p/Qme..."`.

---

## 3. Key methods with exact JSON (v0.9.0)

### 3.1 `node_info`

Params: none (`params: [{}]` or `[]`).

Response (fields, hex-encoded where numeric):

```
version: String
commit_hash: String
pubkey: Pubkey (33-byte hex, no 0x)
features: Vec<String>
node_name: Option<String>
addresses: Vec<String>          // multiaddrs
chain_hash: Hash256
open_channel_auto_accept_min_ckb_funding_amount: u64  (hex string)
auto_accept_channel_ckb_funding_amount: u64           (hex string)
default_funding_lock_script: Script
tlc_expiry_delta: u64 (hex)
tlc_min_value: u128 (hex)
tlc_fee_proportional_millionths: u128 (hex)
channel_count: u32 (hex)
pending_channel_count: u32 (hex)
peers_count: u32 (hex)
udt_cfg_infos: UdtCfgInfos      // configured UDT whitelist entries
```

```json
{"jsonrpc":"2.0","id":1,"method":"node_info","params":[{}]}
```

### 3.2 `connect_peer` / `list_peers` / `disconnect_peer`

```json
{"id":42,"jsonrpc":"2.0","method":"connect_peer","params":[{"address":"/ip4/192.168.1.100/tcp/8228"}]}
```

- Params: `address` (Option\<String\>, multiaddr) **or** `pubkey` (Option\<Pubkey\>, resolved from the synced network graph), `save` (Option\<bool\>, persist the address), `addr_type` (Option\<TransportType\>: `"tcp" | "ws" | "wss"`). Either `address` or `pubkey` must be provided.
- Returns: `null`.

`list_peers` params: none. Returns `{ "peers": [ { "pubkey": "...", "address": "..." } ] }` (`PeerInfo`; `address` is the multiaddr used for the connection).
`disconnect_peer` params: `{ "pubkey": "..." }`; returns `null`.

### 3.3 `open_channel`

Real v0.9.0 e2e request (`tests/bruno/e2e/open-use-close-a-channel/02-open-channel.bru`):

```json
{
  "id": "42",
  "jsonrpc": "2.0",
  "method": "open_channel",
  "params": [
    {
      "pubkey": "{{NODE1_PUBKEY}}",
      "funding_amount": "0xba43b7400",
      "commitment_delay_epoch": "0x20001000003"
    }
  ]
}
```

- `"0xba43b7400"` = 50,000,000,000 shannons = **500 CKB**.
- Response: `{ "result": { "temporary_channel_id": "0x..." } }` — the channel only gets its final `channel_id` after the peer accepts (auto-accept or `accept_channel`).

Full params object:

| Field | Type | Notes |
|---|---|---|
| `pubkey` | Pubkey (required) | peer identity pubkey; peer must already be connected via `connect_peer` |
| `funding_amount` | u128 hex (required) | shannons (CKB) or UDT base units |
| `public` | Option\<bool\> | default **true**; public channels are announced and can route |
| `one_way` | Option\<bool\> | default **false**; `true` = unidirectional channel (see §5) |
| `funding_udt_type_script` | Option\<Script\> | set to fund with a UDT instead of CKB |
| `shutdown_script` | Option\<Script\> | where your channel balance is paid on close; default = secp256k1_blake160_sighash_all of node key |
| `commitment_delay_epoch` | Option\<EpochNumberWithFraction\> | u64-encoded; default 1 epoch ≈ 4 h |
| `commitment_fee_rate` | Option\<u64\> hex | shannons/kW |
| `funding_fee_rate` | Option\<u64\> hex | shannons/kW |
| `tlc_expiry_delta` | Option\<u64\> hex | ms; default 4 h; keep >= 2/3 of commitment_delay_epoch; updatable via `update_channel` |
| `tlc_min_value` | Option\<u128\> hex | default 0; updatable |
| `tlc_fee_proportional_millionths` | Option\<u128\> hex | default 1000 = 0.1%; updatable |
| `max_tlc_value_in_flight` | Option\<u128\> hex | immutable after open |
| `max_tlc_number_in_flight` | Option\<u64\> hex | default 125; immutable after open |

Related: `accept_channel` (`{ temporary_channel_id, funding_amount, shutdown_script?, max_tlc_value_in_flight?, max_tlc_number_in_flight?, tlc_min_value?, tlc_fee_proportional_millionths?, tlc_expiry_delta? }` → `{ channel_id }`) is only needed when the peer does **not** auto-accept (`open_channel_auto_accept_min_ckb_funding_amount` / `auto_accept_channel_ckb_funding_amount` in `node_info`). `abandon_channel` (`{ channel_id }`) removes a not-yet-Ready/failed channel. External funding flow: `open_channel_with_external_funding` → user signs → `submit_signed_funding_tx`.

### 3.4 `list_channels`

```json
{"id":42,"jsonrpc":"2.0","method":"list_channels","params":[{"pubkey":"02aa3beb0d770fe835db99bf894fb2d9afaf4df0d5ec1871fad731d4fc6c90faed"}]}
```

- Params: `pubkey` (Option\<Pubkey\>, filter by counterparty), `include_closed` (Option\<bool\>, default false), `only_pending` (Option\<bool\>, default false; mutually exclusive with `include_closed`).
- Response: `{ "channels": [ Channel, ... ] }`.

Real v0.9.0 response (from `docs/public-nodes.md`, UDT channel shown; native-CKB is identical minus `funding_udt_type_script`):

```json
{"jsonrpc":"2.0","id":3,"result":{"channels":[{
  "channel_id":"0x19380f65a48f88bf69dd07336f231655a183e01bba304485d0fed6a428f329d3",
  "is_public":true,
  "is_acceptor":false,
  "is_one_way":false,
  "channel_outpoint":"0x34efee5b56b48b314d3d75870db4921f34b226d2b224e02bb9d89d3ee77d791c00000000",
  "pubkey":"02b6d4e3ab86a2ca2fad6fae0ecb2e1e559e0b911939872a90abdda6d20302be71",
  "funding_udt_type_script":{"code_hash":"0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a","hash_type":"type","args":"0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b"},
  "state":{"state_name":"ChannelReady"},
  "local_balance":"0x77359400",
  "offered_tlc_balance":"0x0",
  "remote_balance":"0x0",
  "received_tlc_balance":"0x0",
  "pending_tlcs":[],
  "latest_commitment_transaction_hash":"0x9c254a1a8f4be0be28256072568c3490cc1dedb0e2dd1f63ff05b1e5ddf7a10f",
  "created_at":"0x19d72cb19f4",
  "enabled":true,
  "tlc_expiry_delta":"0xdbba00",
  "tlc_fee_proportional_millionths":"0x3e8",
  "shutdown_transaction_hash":null,
  "failure_detail":null}]}}
```

Balances (`local_balance`, `remote_balance`, `offered_tlc_balance`, `received_tlc_balance`) are u128 hex in shannons/UDT base units. Readiness check = `state.state_name === "ChannelReady"`.

### 3.5 `shutdown_channel` (cooperative and force close)

Cooperative (real e2e request, `15-shutdown-from-NODE1.bru`):

```json
{
  "id": "42",
  "jsonrpc": "2.0",
  "method": "shutdown_channel",
  "params": [
    {
      "channel_id": "{{CHANNEL_ID}}",
      "close_script": {
        "code_hash": "0x2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a",
        "hash_type": "data",
        "args": "0x0101010101010101010101010101010101010101"
      },
      "fee_rate": "0x3FC"
    }
  ]
}
```

Force close (real e2e request, `watchtower/force-close-after-multiple-payments/13-force-close.bru`):

```json
{
  "id": "42",
  "jsonrpc": "2.0",
  "method": "shutdown_channel",
  "params": [
    { "channel_id": "{{N1N2_CHANNEL_ID}}", "force": true }
  ]
}
```

- Params: `channel_id` (Hash256, required), `close_script` (Option\<Script\>; only `secp256k1_blake160_sighash_all` supported), `fee_rate` (Option\<u64\> hex; default 1000 shannons/KW, deducted from the closer's balance), `force` (Option\<bool\>, default **false**).
- Per the RPC reference: when `force` is **false**, `close_script`/`fee_rate` apply; when **true**, they are ignored and the defaults chosen at open time are used.
- Returns: `null`. v0.9.0 adds on-chain TLC settlement for force-closed channels (release notes: "On-chain TLC settlement for force-closed channels").

### 3.6 `new_invoice`

Real v0.9.0 e2e request (`invoice-ops/1-gen-invoice.bru`):

```json
{
  "id": "42",
  "jsonrpc": "2.0",
  "method": "new_invoice",
  "params": [
    {
      "amount": "0x64",
      "currency": "Fibd",
      "description": "test invoice",
      "expiry": "0xe10",
      "final_expiry_delta": "0xDFFA0",
      "payment_preimage": "0x<64 hex chars>"
    }
  ]
}
```

Params:

| Field | Type | Notes |
|---|---|---|
| `amount` | u128 hex (required) | shannons for CKB / UDT base units |
| `currency` | `"Fibb" \| "Fibt" \| "Fibd"` | Fibb = mainnet, Fibt = testnet, Fibd = devnet (`Currency` enum) |
| `description` | Option\<String\> | |
| `payment_preimage` | Option\<Hash256\> | if set, `payment_hash` must be absent; if both absent a random preimage is generated |
| `payment_hash` | Option\<Hash256\> | if set (preimage absent) this is a **hold invoice** — TLC is accepted and held until the preimage is provided (then `settle_invoice`) |
| `expiry` | Option\<u64\> hex | seconds (e2e uses `"0xe10"` = 3600 s) |
| `fallback_address` | Option\<String\> | |
| `final_expiry_delta` | Option\<u64\> hex | ms; documented min 16 h, max 14 days |
| `udt_type_script` | Option\<Script\> | UDT invoice |
| `hash_algorithm` | Option\<`"ckb_hash"` \| `"sha256"`\> | |
| `allow_mpp` | Option\<bool\> | allow multi-part payment |
| `allow_trampoline_routing` | Option\<bool\> | |

Response: `{ "invoice_address": "Fibt1...", "invoice": { "currency": "...", "amount": "...", "signature": "...", "data": { "timestamp": "...", "payment_hash": "0x...", "attrs": [...] } } }` — grab `result.invoice.data.payment_hash` (used as the `get_payment` key on the payer side and `get_invoice` key on the payee side).

Lookup / lifecycle: `get_invoice` (`{ payment_hash }` → `{ invoice_address, invoice, status }`), `parse_invoice` (`{ invoice: "<encoded string>" }` → `{ invoice }`), `cancel_invoice` (`{ payment_hash }`, only while status `Open`), `settle_invoice` (`{ payment_hash, payment_preimage }`, for hold invoices).

### 3.7 `send_payment`

Real v0.9.0 e2e requests (`router-pay/12-node1-send-payment.bru`, `15-node1-send-payment-with-invoice.bru`):

```json
{
  "id": "42",
  "jsonrpc": "2.0",
  "method": "send_payment",
  "params": [
    {
      "target_pubkey": "03032b99943822e721a651c5a5b9621043017daa9dc3ec81d83215fd2e25121187",
      "amount": "0x190",
      "payment_hash": "{{payment_hash}}"
    }
  ]
}
```

```json
{
  "id": "42",
  "jsonrpc": "2.0",
  "method": "send_payment",
  "params": [ { "invoice": "{{encoded_invoice}}" } ]
}
```

Params (all optional except as noted):

| Field | Type | Notes |
|---|---|---|
| `target_pubkey` | Option\<Pubkey\> | payee node pubkey (from `node_info`/`graph_nodes`) |
| `amount` | Option\<u128\> hex | shannons for non-UDT; if omitted and an invoice is given, invoice amount is used |
| `payment_hash` | Option\<Hash256\> | required unless an invoice or `keysend` supplies it |
| `invoice` | Option\<String\> | encoded invoice (e.g. from `new_invoice.invoice_address`) |
| `final_tlc_expiry_delta` | Option\<u64\> hex | ms |
| `tlc_expiry_limit` | Option\<u64\> hex | ms; default (N-1) days for N hops |
| `timeout` | Option\<u64\> | seconds; payment is cancelled if not completed in time |
| `max_fee_amount` | Option\<u128\> hex | shannons |
| `max_fee_rate` | Option\<u64\> hex | per thousand, default 5 (0.5%) |
| `max_parts` | Option\<u64\> | MPP parts |
| `trampoline_hops` | Option\<Vec\<Pubkey\>\> | explicit trampoline hops |
| `keysend` | Option\<bool\> | keysend (no invoice); random payment_hash if none given |
| `udt_type_script` | Option\<Script\> | UDT payment |
| `allow_self_payment` | Option\<bool\> | circular self-payment for rebalancing; not compatible with trampoline |
| `custom_records` | Option\<map\> | see §8 |
| `hop_hints` | Option\<Vec\<HopHint\>\> | `{ pubkey, channel_outpoint, fee_rate, tlc_expiry_delta }`; only hints for the last private hop |
| `dry_run` | Option\<bool\> | validate routability/fee without sending |

Response = `GetPaymentCommandResult` (identical object is returned by `get_payment` and listed by `list_payments`):

```json
{
  "payment_hash": "0x...",
  "payment_preimage": null,
  "status": "Inflight",
  "created_at": "0x...",          // ms since UNIX epoch (hex)
  "last_updated_at": "0x...",
  "failed_error": null,
  "fee": "0x0",
  "custom_records": null,
  "routers": [ { "nodes": [ { "pubkey": "...", "amount": "0x...", "channel_outpoint": "0x..." } ] } ]
}
```

### 3.8 `get_payment`

```json
{
  "id": "42",
  "jsonrpc": "2.0",
  "method": "get_payment",
  "params": [ { "payment_hash": "{{payment_hash}}" } ]
}
```

- Params: `payment_hash` (Hash256, required). Response: `GetPaymentCommandResult` above.
- The v0.9.0 e2e test asserts `result.status == "Success"` (plain PascalCase string).

`list_payments`: params `status` (Option\<PaymentStatus\>), `limit` (Option\<u64\>, default 15), `after` (Option\<Hash256\> cursor) → `{ payments: [GetPaymentCommandResult], last_cursor: Option<Hash256> }`.

Router control: `build_router` (`{ amount?, udt_type_script?, hops_info: [{ pubkey, channel_outpoint? }], final_tlc_expiry_delta? }` → `{ router_hops: [RouterHop] }`) + `send_payment_with_router` (`{ payment_hash?, router: [RouterHop], invoice?, custom_records?, keysend?, udt_type_script?, dry_run? }` → `GetPaymentCommandResult`).

### 3.9 Dev TLC methods (not in release builds)

`add_tlc` (`{ channel_id, amount, payment_hash, expiry, hash_algorithm? }` → `{ tlc_id: u64 }`), `remove_tlc` (`{ channel_id, tlc_id, reason: RemoveTlcReason }`), `commitment_signed`, `submit_commitment_transaction`, `check_channel_shutdown`, `sign_external_funding_tx`. The Dev module is documented as "not intended to be used in production. **This module will be disabled in release build**" — do not depend on it; use `send_payment`. TLC state visibility in normal builds is via `list_channels` → `pending_tlcs` (each `Htlc` has `id`, `amount`, `payment_hash`, `expiry`, `forwarding_channel_id?`, `forwarding_tlc_id?`, `status: TlcStatus`), where `TlcStatus` is `Outbound(OutboundTlcStatus)` / `Inbound(InboundTlcStatus)` with sub-states `LocalAnnounced|Committed|RemoteRemoved|RemoveWaitPrevAck|RemoveWaitAck|RemoveAckConfirmed` and `RemoteAnnounced|AnnounceWaitPrevAck|AnnounceWaitAck|Committed|LocalRemoved|RemoveAckConfirmed`.

---

## 4. Channel state enum — exact strings (v0.9.0)

`Channel.state` serializes as an **adjacently tagged object**: `{"state_name": "<PascalCase variant>", "state_flags": "<flags string>"}` (`#[serde(tag = "state_name", content = "state_flags")]` in `crates/fiber-json-types/src/channel.rs`). `state_flags` is present only for flag-bearing variants and is a single **pipe-separated SCREAMING_SNAKE_CASE string** (`define_rpc_flags!` serializes `to_strings().join("|")`).

| `state_name` (exact JSON string) | flags? | Meaning |
|---|---|---|
| `NegotiatingFunding` | `NegotiatingFundingFlags` (incl. `AWAITING_EXTERNAL_FUNDING`) | negotiating channel parameters pre-funding |
| `CollaboratingFundingTx` | e.g. `AWAITING_REMOTE_TX_COLLABORATION_MSG`, `PREPARING_LOCAL_TX_COLLABORATION_MSG`, `OUR_TX_COMPLETE_SENT`, `THEIR_TX_COMPLETE_SENT` | building the funding tx together |
| `SigningCommitment` | `OUR_COMMITMENT_SIGNED_SENT`, `THEIR_COMMITMENT_SIGNED_SENT` | waiting for commitment_signed messages |
| `AwaitingTxSignatures` | `OUR_TX_SIGNATURES_SENT`, `THEIR_TX_SIGNATURES_SENT` | waiting on funding tx signatures |
| `AwaitingChannelReady` | `OUR_CHANNEL_READY`, `THEIR_CHANNEL_READY`, `CHANNEL_READY` | funding tx submitted, waiting confirmations |
| `ChannelReady` | none (`{"state_name":"ChannelReady"}`) | operational — **the "ready" check** |
| `ShuttingDown` | `OUR_SHUTDOWN_SENT`, `THEIR_SHUTDOWN_SENT`, `AWAITING_PENDING_TLCS`, `DROPPING_PENDING`, `WAITING_COMMITMENT_CONFIRMATION` | cooperative shutdown in progress |
| `Closed` | `COOPERATIVE`, `UNCOOPERATIVE_LOCAL`, `ABANDONED`, `FUNDING_ABORTED`, `UNCOOPERATIVE_REMOTE`, `WAITING_ONCHAIN_SETTLEMENT` | closed (flag tells you how) |
| `Stale` | none | state possibly outdated (e.g. after DB restore); passive audit needed |

Examples: `"state": {"state_name":"ChannelReady"}`, `"state": {"state_name":"Closed","state_flags":"COOPERATIVE"}`, `"state": {"state_name":"AwaitingChannelReady","state_flags":"OUR_CHANNEL_READY | THEIR_CHANNEL_READY"}`.

**Compatibility warning:** the fiber-docs `simple-game` example still checks `channel.state.stateName === "CHANNEL_READY"` — that is the legacy pre-v0.7 serialization (SCREAMING_SNAKE_CASE value, camelCased by an old JS SDK). For **v0.9.0 you must check `state.state_name === "ChannelReady"`** (PascalCase). `state_flags` values themselves are SCREAMING_SNAKE_CASE. (The old `WAITING_CHANNEL_READY` / `CHANNEL_CLOSING` names from early Fiber versions no longer exist; the equivalents are `AwaitingChannelReady` and `ShuttingDown`/`Closed`.)

## 4b. Payment status enum — exact strings

`PaymentStatus` = plain PascalCase strings; documented lifecycle `Created -> Inflight -> Success | Failed`:

| Status | Meaning |
|---|---|
| `"Created"` | payment session created, no HTLC/TLC dispatched |
| `"Inflight"` | first-hop AddTlc sent, awaiting response |
| `"Success"` | all HTLCs settled — **`payment_preimage` is populated** |
| `"Failed"` | session terminated (see `failed_error`); **timeouts surface here** — there is no separate `"Timeout"` value in v0.9.0 |

Invoice status (`CkbInvoiceStatus`, from `get_invoice`/`cancel_invoice`): `"Open"`, `"Cancelled"`, `"Expired"`, `"Received"` (received but not settled), `"Paid"`.
CCH order status (`CchOrderStatus`): `Pending`, `IncomingAccepted`, `OutgoingInFlight`, `OutgoingSuccess`, `Success`, `Failed`.

---

## 5. Private / bidirectional / UDT channels in `open_channel`

- **Public channel (default):** `public: true` — announced to the network, eligible for routing. For a **private channel** set `"public": false`.
- **Bidirectional (default):** `one_way: false`. Set `"one_way": true` for a unidirectional channel (cannot forward/pay in both directions; `is_one_way` + `is_acceptor` on the `Channel` object determine who can send).
- So a "private bidirectional" channel is simply `{"public": false, "one_way": false}` (both are the defaults except `public`).
- **UDT / asset support:** pass `funding_udt_type_script: {"code_hash","hash_type","args"}` (an xUDT/sudt type script) to fund the channel in a token; same field exists on `accept_channel`. The UDT must be known to the node (`ckb.udt_whitelist` in config.yml — testnet sample whitelists RUSD; `node_info.udt_cfg_infos` exposes the whitelist). For payments/invoices use `udt_type_script` on `send_payment` / `new_invoice`. `graph_channels` items also carry `udt_type_script`.

## 6. payment_hash / preimage pattern (simple-game)

The `simple-game` example (`fiber-docs/example/simple-game/src/fiber/node.ts` + `src/fiber/index.ts`) shows the intended game/settlement flow, implemented over `new_invoice` + `send_payment` via the `@ckb-ccc/fiber` SDK:

1. Payee generates a random 32-byte preimage client-side: `crypto.getRandomValues(new Uint8Array(32))` → `0x`-prefixed hex.
2. Payee calls `new_invoice` with `{ amount, currency: "Fibt", description, expiry: "0xe10", payment_preimage }` — supplying the preimage explicitly means the payer can later learn/prove it. (Alternatively omit it and FNN generates a random one; or pass `payment_hash` instead for a hold invoice.)
3. Payee hands the encoded `invoice_address` to the payer; payer calls `send_payment { invoice }` and polls `get_payment { payment_hash }` until `status === "Success"`; the response then contains `payment_preimage` — proof of payment the payer can hand back to the game server (in the example, "1 CKB per point": `amountPerPoint = 1 * 10 ** 8` shannons, amount = `0x` + hex).
4. On the payee side, `get_invoice { payment_hash }` transitions to status `"Paid"`.
5. Connection setup in the example: `connect_peer { address }`, then poll `list_channels { pubkey }` and wait for `state` == ready before paying (legacy code shows the SCREAMING case — see warning in §4).

Keysend alternative (no invoice): `send_payment { target_pubkey, amount, keysend: true }` — FNN generates the preimage/hash; the payee's invoice tracking is skipped, and the payee learns the preimage only from payment settlement.

## 7. Custom records

`send_payment` and `send_payment_with_router` accept `custom_records` (type `PaymentCustomRecords`):

```json
"custom_records": {
  "0x1": "0x01020304",
  "0x2": "0x05060708",
  "0x3": "0x090a0b0c",
  "0x4": "0x0d0e0f10010d090a0b0c"
}
```

- Keys: hex-encoded `u32` **with documented range limited to 0–65535**; values: `0x`-prefixed hex byte strings.
- Size limit (documented under `send_payment_with_router`, same type elsewhere): **"the sum size of values can not exceed 2048 bytes"**.
- Echoed back in `get_payment`/`send_payment` results as `custom_records` (i.e. the receiver can read them via their own node's payment/tlc data — for routing-hopped payments the records ride the onion; for a direct/receiver-visible read the `get_payment` result on the *sender* is what's documented).

## 8. Watchtower in v0.9.0

- **RPC module `Watchtower`**: `create_watch_channel` (`{ channel_id, funding_udt_type_script?, local_settlement_key (Privkey), remote_settlement_key (Pubkey), local_funding_pubkey, remote_funding_pubkey, settlement_data }`), `remove_watch_channel` (`{ channel_id }`), `update_revocation` (`{ channel_id, revocation_data, settlement_data }`), `update_pending_remote_settlement` (`{ channel_id, settlement_data }`), `update_local_settlement` (`{ channel_id, settlement_data }`), `create_preimage` (`{ payment_hash, preimage }`), `remove_preimage` (`{ payment_hash }`). All return `null`. This is an advanced/self-custody API (you hand the watchtower settlement keys/data from your channel state).
- **Config** (fiber section of config.yml / env / CLI, from `crates/fiber-lib/src/fiber/config.rs`): `watchtower_check_interval_seconds` (default 60; 0 = never), `standalone_watchtower_rpc_url` (use an external watchtower instead of the built-in one), `standalone_watchtower_token` (auth token for the standalone watchtower), `disable_built_in_watchtower` (default false; node requires either a built-in watchtower or a standalone URL).
- v0.9.0 release notes: watchtower settlement, cleanup, error handling and recovery improvements + "On-chain TLC settlement for force-closed channels".

## 9. Occupied capacity on native-CKB channels (~99 CKB)

Stated verbatim in the v0.9.0 `docs/public-nodes.md` ("Channel Capacity" section):

> "When opening a channel, each side must reserve 99 CKB (98 CKB for commitment lock occupied capacity + 1 CKB for shutdown transaction fee) to ensure sufficient funds for on-chain settlement when the channel closes. This reserved amount is not available for off-chain payments."

Example given there: fund 499 CKB → 400 CKB usable; peer funding 250 CKB → 151 CKB usable. `docs/network-nodes.md` likewise describes the public nodes' `open_channel_auto_accept_min_ckb_funding_amount = 49900000000` (≥ 499 CKB auto-accepted; **"99 CKB collateral"**). So per side: usable balance = `local_balance` (funding − 99 CKB), and any `funding_amount` below 99 CKB cannot open a channel.

## 10. WebSocket / subscriptions

- **No subscription/notification RPC exists in v0.9.0.** The generated RPC reference contains no `*_subscribe` / event-stream methods. The required pattern is polling: `get_payment` for payments, `list_channels` (filter `state.state_name`) for channels, `get_invoice` (status → `Received`/`Paid`) for incoming invoices.
- The JSON-RPC server (jsonrpsee-based, `crates/fiber-lib/src/rpc/mod.rs`) is documented and exercised as **HTTP POST** on one port (`rpc.listening_addr`, default `127.0.0.1:8227`). WebSocket-secure ("WSS") documentation (`docs/fiber-node-wss.md`) concerns the **P2P transport** so browser/WASM nodes can connect to the gossip network through a TLS proxy — it is *not* an RPC pub/sub channel.
- `TransportType` (`tcp` | `ws` | `wss`) appears only as an address filter in `connect_peer`/node addresses.

---

## 11. Could NOT verify / caveats

1. **`channel_ready`-style dedicated RPC**: does not exist in v0.9.0 (absent from the generated reference). Verified by absence in the method index; poll `list_channels` instead.
2. **`send_invoice_payment`**: absent from the v0.9.0 method list (verified against the generated RPC reference module index). Any code using it targets an older Fiber release.
3. **WebSocket transport for the RPC port**: jsonrpsee *can* serve WS, but FNN v0.9.0 documentation and e2e tests only exercise HTTP POST, and there are no subscriptions either way — treat HTTP polling as the only supported integration surface. (Not explicitly verified on a live node.)
4. **Exact default `expiry` for `new_invoice` when omitted**: not stated in the v0.9.0 RPC reference (only "in seconds"); the e2e tests always pass it explicitly. Pass it explicitly.
5. **`final_expiry_delta` min/max (16 h / 14 d) vs e2e usage**: the reference documents a 16-hour minimum, while a devnet e2e test sends `0xDFFA0` (~15 min); the enforced bound appears context-dependent. Treat the documented 16 h as the production-safe value and verify against your node.
6. **fiber-docs site / simple-game example lag**: `fiber-docs@master` API reference matches the v0.9.0 generated docs, but the `simple-game` example code still uses the legacy channel-state check (`stateName === "CHANNEL_READY"`) and the `@ckb-ccc/fiber` SDK — do not copy that state check for v0.9.0.
7. **`node_info` numeric fields**: the generated reference says several `node_info` fields ("serialized as a hexadecimal string") — the serde types confirm `U64Hex`/`U128Hex` encoding, but the exact `node_info` JSON sample was not captured from a live v0.9.0 node; field names are verified from the reference + `crates/fiber-json-types/src/info.rs` listing.
8. **Biscuit auth wire behavior**: documented in `docs/biscuit-auth.md` (Bearer token, per-method rules like `write("channels")` for `open_channel`); only relevant if you bind RPC to a public address.

---

*Compiled 2026-09-10. All names/shapes reflect tag `v0.9.0`; the FNN RPC is explicitly "not stable yet and may change in the future" (per the RPC reference header).*

---

## VERIFIED AGAINST A LIVE NODE (2026-09-10)

Node: `fnn 0.9.0-rc7` (commit `bc361aa`, 2026-07-02) at `192.168.68.80:8227`,
Biscuit-authenticated (`Authorization: Bearer <base64>`). Validated with
`tests/fiber/live-node.test.ts` (gated suite — auth, node_info, list_channels,
full invoice lifecycle) plus a RealFiberGateway smoke. **Four corrections to
the desk-checked shapes above; everything else matched.**

### Corrections found live

1. **`node_info` returns `pubkey`, not `node_pubkey`.** `node_name` may be
   `null`. Full observed result: `{ version: "0.9.0-rc7", commit_hash:
   "bc361aa 2026-07-02", pubkey: "024508b9…", features: [...],
   addresses: [multiaddr…], chain_hash: "0x…",
   open_channel_auto_accept_min_ckb_funding_amount: "0x2540be400" (5 CKB),
   auto_accept_channel_ckb_funding_amount: "0x24e160300" (99 CKB — the
   channel collateral figure from §E, confirmed live), … }`.
2. **`list_channels` entries use `pubkey`** for the peer (not
   `peer_pubkey`) and the channel state is a **nested, adjacently-tagged
   object**: `"state": { "state_name": "ChannelReady" }` — not a flat
   `state_name` string. Other observed fields: `channel_outpoint`,
   `funding_udt_type_script`, `enabled`, `pending_tlcs`, `created_at` (0x
   unix), `latest_commitment_transaction_hash`, `failure_detail`,
   `tlc_expiry_delta`, `tlc_fee_proportional_millionths`.
3. **`new_invoice` REQUIRES `currency`** (`Fibb`/`Fibt`/`Fibd`) — omitting
   it yields `-32602 Invalid params: "missing field `currency`"`. Testnet
   invoices mint `fibt1…` invoice addresses. The full lifecycle verified
   live: new_invoice → get_invoice (`Open`) → cancel_invoice → get_invoice
   (`Cancelled`).
4. Pubkey regexes: 33 bytes = **66 hex chars total** (`^(02|03)[0-9a-f]{64}$`).

### Confirmed live (no changes needed)

- JSON-RPC 2.0 with array-wrapped params; auth middleware order (parse error
  `-32700` precedes auth `-32999`; missing/garbage/wrong-scheme tokens all
  yield bare `Unauthorized`).
- Bearer auth header form; per-method Biscuit rules (this token carries
  read+write on peers/channels/payments/invoices and works for all probed
  methods).
- `0x`-prefixed hex numbers, shannon amounts, `Hash256` formats, multiaddr
  peer addresses, PascalCase channel states (`ChannelReady` observed).
- RealFiberGateway (auth, nodePubkey, listChannels mapping) works against
  the live node unchanged once the four corrections above were applied.

### Operational notes from the live node

- The node's channels were ACCEPTED (local_balance = 0): a table node must
  have its own funded side or payouts fail — top-up before hosting games.
- Auto-accept is on: minimum inbound funding 5 CKB, and the node itself
  auto-funds 99 CKB when accepting — factor into liquidity planning.
- Peer seen: `/ip4/192.168.68.102/…` (driveThree), 2 channels, 1 peer.

### Live channel-open findings (2026-09-10, later the same day)

1. **`open_channel` requires BOTH `peer_id` AND `pubkey`** (same value,
   unprefixed pubkey hex). Omitting `pubkey` → `-32602: missing field
   'pubkey'`. Not in the desk-checked reference.
2. **Auto-accept minimum enforced server-side with exact text**:
   `"The funding amount (600000000) should be greater than or equal to
   9900000000"` — driveThree's auto-accept minimum is 99 CKB. Amounts
   below it are rejected synchronously.
3. **An open whose funding the opener cannot cover aborts as
   `Closed/FUNDING_ABORTED`** (observed with a 100,000 CKB open — hex slip;
   `0x2386f26fc10000` is 1e13 shannons). Aborted opens leave a
   `local_balance`-showing corpse in `list_channels {only_pending:true}`.
4. **NegotiatingFunding can stall indefinitely when the ACCEPTOR's wallet
   cannot cover its auto-accept contribution**: both inits exchange
   (`OUR_INIT_SENT|INIT_SENT`) and then nothing happens — observed for 5+
   minutes. Treat "NegotiatingFunding older than ~1 min" as a wallet-funding
   problem on the accepting node, not a transport issue.
5. Aborted opens also leave accumulating `NegotiatingFunding` ghosts
   (empty state_flags, local 0); each open attempt adds one. No cleanup RPC
   observed on rc7.

### Channel-phase test status

- Channel open: attempted; stalled at acceptor wallet (see #4). To finish
  the 2-player funded-hand test, the accepting node (driveThree) needs
  on-chain funds, or a manual `accept_channel` via its own Biscuit token.
