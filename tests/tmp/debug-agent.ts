import * as fs from "node:fs";
const log = (s: string): void => { fs.writeSync(1, s + "\n"); };
import { generateKeyPair } from "@fiber-poker/protocol";
import { RealFiberGateway } from "@fiber-poker/fiber-adapter";
import { ImmediateFiberSettlement } from "@fiber-poker/settlement";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { PlayerAgent } from "../../apps/player-agent/src/agent.ts";
const K = 100_000_000n;
async function main() {
  const tableGateway = new RealFiberGateway({ url: process.env.FIBER_POKER_FNN_URL!, authToken: process.env.FIBER_POKER_FNN_TOKEN!, currency: "Fibt" });
  const playerGateway = new RealFiberGateway({ url: process.env.FIBER_POKER_PLAYER_FNN_URL!, authToken: process.env.FIBER_POKER_PLAYER_FNN_TOKEN!, currency: "Fibt" });
  const playerPeer = await playerGateway.nodePubkey();
  const aliceKp = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));

  const adapter = new ImmediateFiberSettlement(tableGateway, {
    pollMs: 250, timeoutMs: 30_000,
    resolvePeer: (id) => (id === aliceKp.publicKey ? playerPeer : id),
  });
  adapter.onPaymentRequest((req) => {
    log(`PAYREQ ${req.obligation.reason} ${req.obligation.amountShannons}`);
    playerGateway.payInvoice(req.invoiceAddress!).then(
      () => log("paid"), (e) => log("PAYFAIL " + String(e).slice(0, 120)));
  });

  const server = new TableServer(
    { port: 0, dataDir: ".data/live-agent-debug", turnTimeoutMs: 30_000, peerMapJson: JSON.stringify({ [aliceKp.publicKey]: playerPeer }) },
    { gateway: tableGateway, adapter, events: new InMemoryEventStore(), snapshots: new InMemorySnapshotStore(), keys: generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n))) },
  );
  await server.start();

  const agent = new PlayerAgent({
    tableUrl: `ws://127.0.0.1:${server.port}`,
    fnnUrl: process.env.FIBER_POKER_PLAYER_FNN_URL!, fnnToken: process.env.FIBER_POKER_PLAYER_FNN_TOKEN!, currency: "Fibt",
    sessionKeyPath: ".data/live-agent-debug/alice.json", buyInShannons: 10n * K, label: "agent-alice", policy: "call-station",
  });
  const origIngest = (agent as any).ingest.bind(agent);
  (agent as any).ingest = (m: any) => { log(`agent< ${m.type} ${JSON.stringify(m.payload ?? {}).slice(0, 130)}`); origIngest(m); };

  await agent.join();
  log("JOINED — playing…");
  await agent.playLoop();
  log("done");
  await server.stop();
  process.exit(0);
}
main().catch((e) => { console.error("FATAL " + (e.stack || e).slice(0, 400)); process.exit(1); });
