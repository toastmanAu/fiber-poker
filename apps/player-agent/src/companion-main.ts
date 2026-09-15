import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateKeyPair, publicKeyFromPrivate } from "@fiber-poker/protocol";
import { RealFiberGateway } from "@fiber-poker/fiber-adapter";
import { PlayerCompanion } from "./companion.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
async function main(): Promise<void> {
  const tableUrl = arg("table") ?? process.env.FIBER_POKER_TABLE_URL;
  const fnnUrl = arg("fnn-url") ?? process.env.FIBER_POKER_FNN_URL;
  const fnnToken = process.env.FIBER_POKER_FNN_TOKEN;
  if (!tableUrl || !fnnUrl || !fnnToken)
    throw new Error(
      "Set FIBER_POKER_TABLE_URL, FIBER_POKER_FNN_URL and FIBER_POKER_FNN_TOKEN.",
    );
  const name = arg("name") ?? process.env.FIBER_POKER_AGENT_NAME ?? "agent";
  const keyPath =
    arg("key-file") ??
    join(
      arg("key-dir") ?? ".data/agents",
      `${name.replace(/[^a-zA-Z0-9-]/g, "_")}.session.json`,
    );
  // On-ramp: --generate-identity creates (or reuses) a poker identity for
  // this player and serves it to the loopback browser on request.
  const generate = process.argv.includes("--generate-identity");
  let generatedIdentity: { privateKey: string; publicKey: string } | undefined;
  let keys: { privateKey: string; publicKey: string };
  if (generate && !existsSync(keyPath)) {
    keys = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, JSON.stringify(keys), { mode: 0o600 });
    generatedIdentity = keys;
    console.log(`[companion] generated new poker identity: ${keys.publicKey}`);
  } else {
    keys = JSON.parse(readFileSync(keyPath, "utf8")) as {
      privateKey: string;
      publicKey: string;
    };
    if (generate) generatedIdentity = keys; // reuse + serve on request
  }
  if (
    !/^[0-9a-f]{64}$/.test(keys.privateKey) ||
    publicKeyFromPrivate(keys.privateKey) !== keys.publicKey
  )
    throw new Error("Invalid agent poker identity file.");
  const port = Number(arg("port") ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid companion port.");
  const payInvoices = process.argv.includes("--pay-invoices");
  const ensureCapacityCkb = Number(arg("ensure-capacity-ckb") ?? 0);
  const minCapacityShannons =
    Number.isFinite(ensureCapacityCkb) && ensureCapacityCkb > 0
      ? BigInt(Math.round(ensureCapacityCkb * 100_000_000))
      : undefined;
  const companion = new PlayerCompanion({
    tableUrl,
    playerId: keys.publicKey,
    port,
    payInvoices,
    generatedIdentity,
    minCapacityShannons,
    gateway: new RealFiberGateway({
      url: fnnUrl,
      authToken: fnnToken,
      currency: "Fibt",
    }),
    allowedOrigins: arg("web-origin")
      ? [new URL(arg("web-origin")!).origin]
      : ["http://localhost:5173", "http://127.0.0.1:5173"],
  });
  await companion.start();
  console.log(
    `Browser companion: ws://127.0.0.1:${companion.port}\nChoose poker identity file: ${keyPath}`,
  );
  console.log(
    `Player: ${keys.publicKey}\nDEVNET/TESTNET PLAY VALUE ONLY. ${payInvoices ? "Invoice payment enabled; browser chooses actions." : "Observe-only: invoice payment disabled. Use --pay-invoices to enable."}`,
  );
  const stop = async () => {
    await companion.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}
main().catch(() => {
  console.error(
    "Companion failed to start. Check the table/node configuration, existing identity file and local port.",
  );
  process.exitCode = 1;
});
