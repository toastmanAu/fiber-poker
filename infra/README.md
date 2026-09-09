# infra/

Deployment templates for a production-like devnet topology:

- `ckb-devnet/` — CKB devnet chain + miner compose template
- `fnn/` — table FNN node config template (v0.9.0-compatible RPC)
- `watchtower/` — standalone watchtower config template

See `docs/deployment.md` for the full bring-up sequence and
`docs/fnn-compat.md` for the verified RPC surface. Everything here is
**devnet/testnet only**.
