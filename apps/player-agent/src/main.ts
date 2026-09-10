/**
 * Player agent entrypoint.
 *
 *   FIBER_POKER_TABLE_URL=ws://127.0.0.1:8080 \
 *   FIBER_POKER_AGENT_NAME=alice \
 *   FIBER_POKER_FNN_URL=http://192.168.68.102:8231 \
 *   FIBER_POKER_FNN_TOKEN=<player biscuit> \
 *   FIBER_POKER_BUY_IN_CKB=10 \
 *   npm run agent -w @fiber-poker/player-agent
 *
 * The session key is generated/persisted under --key-dir (default .data/agent).
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PlayerAgent } from "./agent.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const name = arg("name") ?? process.env.FIBER_POKER_AGENT_NAME ?? "agent";
  const keyDir = arg("key-dir") ?? join(process.env.FIBER_POKER_DATA_DIR ?? ".data", "agents");
  mkdirSync(keyDir, { recursive: true });

  const tableUrl = arg("table") ?? process.env.FIBER_POKER_TABLE_URL;
  const fnnUrl = arg("fnn-url") ?? process.env.FIBER_POKER_FNN_URL;
  const fnnToken = arg("fnn-token") ?? process.env.FIBER_POKER_FNN_TOKEN;
  if (!tableUrl || !fnnUrl || !fnnToken) {
    console.error("usage: player-agent --table ws://… --fnn-url http://… --fnn-token <biscuit> [--name alice] [--buy-in-ckb 10] [--policy call-station]");
    process.exit(1);
  }

  const buyInCkb = Number(arg("buy-in-ckb") ?? process.env.FIBER_POKER_BUY_IN_CKB ?? 10);
  const agent = new PlayerAgent({
    tableUrl,
    fnnUrl,
    fnnToken,
    currency: "Fibt",
    sessionKeyPath: join(keyDir, `${name.replace(/[^a-zA-Z0-9-]/g, "_")}.session.json`),
    buyInShannons: BigInt(Math.round(buyInCkb * 100_000_000)),
    label: name,
    policy: (arg("policy") as "tight" | "call-station") ?? (process.env.FIBER_POKER_AGENT_POLICY as "tight" | "call-station") ?? "call-station",
  });

  const shutdown = async (): Promise<void> => {
    console.log(`[${name}] leaving…`);
    await agent.leave();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await agent.run();
}

main().catch((e) => {
  console.error("[player-agent] fatal:", e);
  process.exit(1);
});
