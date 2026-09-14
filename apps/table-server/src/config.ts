import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateKeyPair } from "@fiber-poker/protocol";

export interface TableServerConfig {
  tableId: string;
  port: number;
  host: string;
  dataDir: string;
  /** fake (dev/CI) | fiber (immediate) | hold (experimental hold invoices) */
  settlement: "fake" | "fiber" | "hold";
  /** FNN RPC endpoint when settlement = fiber. */
  fnnUrl?: string;
  fnnToken?: string;
  /** Dev convenience: fake adapter auto-approves player payments. */
  autoPay: boolean;
  autoStartHands: boolean;
  autoCapacity: boolean;
  turnTimeoutMs: number;
  smallBlind: bigint;
  bigBlind: bigint;
  maxSeats: number;
  /** Channel funding per seat (table side), shannons. */
  channelFunding: bigint;
  /** Snapshot every N events. */
  snapshotEvery: number;
  /** Rate limits. */
  rateLimitPerSecond: number;
  maxMessageBytes: number;
  /** Max wait for one settlement obligation to reach commit-able status. */
  settlementTimeoutMs: number;
  /** server-commit-reveal (V0) | multiparty-seed (P10). */
  deck: "server-commit-reveal" | "multiparty-seed";
  /** Per-phase deadline for the multiparty seed protocol. */
  seedTimeoutMs: number;
  /**
   * Poker session pubkey -> Fiber node pubkey (docs/15: a player's fiber
   * node key differs from their poker session key). JSON object; identity
   * mapping for keys not present.
   */
  peerMapJson?: string;
}

function env(name: string): string | undefined {
  return process.env[name];
}

function envBool(name: string, dflt: boolean): boolean {
  const v = env(name);
  return v === undefined ? dflt : v === "true" || v === "1";
}

function envInt(name: string, dflt: number): number {
  const v = env(name);
  return v === undefined ? dflt : Number.parseInt(v, 10);
}

const SHANNONS = 100_000_000n; // 1 CKB

export function loadConfig(overrides: Partial<TableServerConfig> = {}): TableServerConfig {
  const cfg: TableServerConfig = {
    tableId: env("FIBER_POKER_TABLE_ID") ?? "fiber-poker-table-1",
    port: envInt("FIBER_POKER_PORT", 8080),
    host: env("FIBER_POKER_HOST") ?? "127.0.0.1",
    dataDir: env("FIBER_POKER_DATA_DIR") ?? join(process.cwd(), ".data", "table"),
    settlement: (env("FIBER_POKER_SETTLEMENT") as "fake" | "fiber" | "hold") ?? "fake",
    fnnUrl: env("FIBER_POKER_FNN_URL"),
    fnnToken: env("FIBER_POKER_FNN_TOKEN"),
    autoPay: envBool("FIBER_POKER_AUTO_PAY", true),
    autoStartHands: envBool("FIBER_POKER_AUTO_START_HANDS", true),
    /** Fiber mode: auto-open a table-funded channel when a join's payout
     *  capacity is short (player-side capacity is the player's own job —
     *  the agent/companion provisions it). */
    autoCapacity: envBool("FIBER_POKER_AUTO_CAPACITY", true),
    turnTimeoutMs: envInt("FIBER_POKER_TURN_TIMEOUT_MS", 30_000),
    smallBlind: BigInt(env("FIBER_POKER_SMALL_BLIND") ?? "100000000"), // 1 CKB
    bigBlind: BigInt(env("FIBER_POKER_BIG_BLIND") ?? "200000000"), // 2 CKB
    maxSeats: envInt("FIBER_POKER_MAX_SEATS", 6),
    channelFunding: BigInt(env("FIBER_POKER_CHANNEL_FUNDING") ?? `${1000n * SHANNONS}`),
    snapshotEvery: envInt("FIBER_POKER_SNAPSHOT_EVERY", 200),
    rateLimitPerSecond: envInt("FIBER_POKER_RATE_LIMIT", 20),
    maxMessageBytes: envInt("FIBER_POKER_MAX_MESSAGE_BYTES", 64 * 1024),
    settlementTimeoutMs: envInt("FIBER_POKER_SETTLEMENT_TIMEOUT_MS", 120_000),
    deck: (env("FIBER_POKER_DECK") as "server-commit-reveal" | "multiparty-seed") ?? "server-commit-reveal",
    seedTimeoutMs: envInt("FIBER_POKER_SEED_TIMEOUT_MS", 2000),
    peerMapJson: env("FIBER_POKER_PEER_MAP"),
    ...overrides,
  };
  return cfg;
}

/** Server identity key, persisted in the data dir (devnet convenience). */
export function loadOrCreateServerKeys(dataDir: string): { privateKey: string; publicKey: string } {
  const path = join(dataDir, "server-key.json");
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  const keys = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(keys), "utf8");
  return keys;
}

/** Per-player dev keys (harness/demo helper; never used in production flows). */
export function loadOrCreatePlayerKeys(dataDir: string, playerId: string): { privateKey: string; publicKey: string } {
  const dir = join(dataDir, "players");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${playerId.replace(/[^a-zA-Z0-9-]/g, "_")}.json`);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  const keys = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
  writeFileSync(path, JSON.stringify(keys), "utf8");
  return keys;
}
