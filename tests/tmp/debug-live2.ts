import * as fs from "node:fs";
const log = (s: string): void => { fs.writeSync(1, s + "\n"); };
import { generateKeyPair } from "@fiber-poker/protocol";
import { RealFiberGateway } from "@fiber-poker/fiber-adapter";
import { ImmediateFiberSettlement } from "@fiber-poker/settlement";
import { TableServer } from "@fiber-poker/table-server";
import { InMemoryEventStore, InMemorySnapshotStore } from "@fiber-poker/persistence";
import { TestClient } from "../integration/helpers/client.ts";
const K = 100_000_000n;
async function main() {
  const tableGateway = new RealFiberGateway({ url: process.env.FIBER_POKER_FNN_URL!, authToken: process.env.FIBER_POKER_FNN_TOKEN, currency: "Fibt" });
  const playerGateway = new RealFiberGateway({ url: process.env.FIBER_POKER_PLAYER_FNN_URL!, authToken: process.env.FIBER_POKER_PLAYER_FNN_TOKEN, currency: "Fibt" });
  const playerPubkey = await playerGateway.nodePubkey();
  const aliceKp = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
  const peerMap: Record<string, string> = { [aliceKp.publicKey]: playerPubkey };
  log("peerMap: " + JSON.stringify(Object.keys(peerMap)[0].slice(0, 10)) + " -> " + playerPubkey.slice(0, 10));

  const adapter = new ImmediateFiberSettlement(tableGateway, {
    pollMs: 250, timeoutMs: 30_000,
    resolvePeer: (id) => (peerMap[id] ? (log(`resolvePeer ${id.slice(0,8)} -> ${peerMap[id].slice(0,8)}`), peerMap[id]) : (log(`resolvePeer ${id.slice(0,8)} -> IDENTITY`), id)),
  });
  adapter.onPaymentRequest((req) => {
    log(`PAYREQ ${req.obligation.reason} ${req.obligation.amountShannons} addr=${req.invoiceAddress?.slice(0, 20)}`);
    playerGateway.payInvoice(req.invoiceAddress!).then(
      (r) => log(`paid ${r.paymentHash.slice(0, 12)}`),
      (e) => log(`PAY FAILED ${String(e)}`),
    );
  });

  const server = new TableServer(
    { port: 0, dataDir: ".data/live2", turnTimeoutMs: 30_000, peerMapJson: JSON.stringify(peerMap) },
    { gateway: tableGateway, adapter, events: new InMemoryEventStore(), snapshots: new InMemorySnapshotStore(), keys: generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n))) },
  );
  await server.start();

  const alice = new TestClient(aliceKp, "alice");
  const orig = (alice as any).ingest.bind(alice);
  (alice as any).ingest = (m: any) => { log(`alice< ${m.type} ${JSON.stringify(m.payload ?? {}).slice(0, 110)}`); orig(m); };
  await alice.connect(`ws://127.0.0.1:${server.port}`);
  try { await alice.joinTable(10n * K); log("JOINED"); } catch (e) { log("join error " + String(e)); }
  const events = await (server as any).events.readAll();
  log("events: " + events.map((e: any) => e.eventType).join(","));
  await server.stop();
  process.exit(0);
}
main().catch((e) => { console.error("FATAL " + (e.stack || e)); process.exit(1); });
