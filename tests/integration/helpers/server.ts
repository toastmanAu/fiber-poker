/**
 * Shared helpers to spin up a table server for tests/demos with in-memory
 * stores, ephemeral ports, and the fake settlement adapter.
 */

import { TableServer, type TableServerConfig } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { FakeSettlementAdapter } from "@fiber-poker/settlement";
import { generateKeyPair } from "@fiber-poker/protocol";

export interface TestServerOptions extends Partial<TableServerConfig> {
  adapter?: FakeSettlementAdapter;
}

export async function startTestServer(options: TestServerOptions = {}): Promise<{
  server: TableServer;
  adapter: FakeSettlementAdapter;
  url: string;
}> {
  const events = new InMemoryEventStore();
  const snapshots = new InMemorySnapshotStore();
  const adapter = options.adapter ?? new FakeSettlementAdapter();
  const keys = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
  const server = new TableServer(
    {
      port: 0, // ephemeral
      dataDir: `.data/test-${Math.random().toString(36).slice(2)}`,
      turnTimeoutMs: options.turnTimeoutMs ?? 3000,
      ...options,
    },
    { events, snapshots, adapter, keys },
  );
  await server.start();
  return { server, adapter, url: `ws://127.0.0.1:${server.port}` };
}

export const K = 100_000_000n; // 1 CKB
