/**
 * Table server entrypoint.
 *
 *   FIBER_POKER_SETTLEMENT=fake   -> in-memory settlement (dev/CI, default)
 *   FIBER_POKER_SETTLEMENT=fiber  -> real FNN node over JSON-RPC (devnet!)
 *
 * Devnet/testnet only. This build contains no real-money release path.
 */

import { RealFiberGateway } from "@fiber-poker/fiber-adapter";
import { FileEventStore, FileSnapshotStore } from "@fiber-poker/persistence";
import { FakeSettlementAdapter, ImmediateFiberSettlement } from "@fiber-poker/settlement";
import { mkdirSync } from "node:fs";
import { loadConfig, loadOrCreateServerKeys } from "./config.ts";
import { TableServer } from "./server.ts";

async function main(): Promise<void> {
  const cfg = loadConfig();
  mkdirSync(cfg.dataDir, { recursive: true });
  const keys = loadOrCreateServerKeys(cfg.dataDir);

  let gateway = null;
  let adapter;
  if (cfg.settlement === "fiber") {
    if (!cfg.fnnUrl) throw new Error("FIBER_POKER_FNN_URL is required when FIBER_POKER_SETTLEMENT=fiber");
    gateway = new RealFiberGateway({ url: cfg.fnnUrl, authToken: cfg.fnnToken });
    adapter = new ImmediateFiberSettlement(gateway, { pollMs: 500, timeoutMs: 120_000 });
    console.log(`[fiber-poker] settlement: ImmediateFiberSettlement via ${cfg.fnnUrl}`);
  } else {
    adapter = new FakeSettlementAdapter();
    console.log("[fiber-poker] settlement: FakeSettlementAdapter (DEV ONLY - no real Fiber)");
  }

  const server = new TableServer(
    { ...cfg },
    {
      gateway,
      adapter,
      keys,
      events: new FileEventStore(`${cfg.dataDir}/events.ndjson`),
      snapshots: new FileSnapshotStore(`${cfg.dataDir}/snapshot.json`),
    },
  );

  await server.start();
  console.log(`[fiber-poker] table ${cfg.tableId} listening on ${cfg.host}:${cfg.port}`);
  console.log("[fiber-poker] TRUST MODEL: authoritative-but-auditable coordinator (not trustless)");
  console.log("[fiber-poker] RELEASE GATE: devnet/testnet or non-redeemable play value ONLY");

  const shutdown = async (): Promise<void> => {
    console.log("[fiber-poker] shutting down");
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error("[fiber-poker] fatal:", e);
  process.exit(1);
});
