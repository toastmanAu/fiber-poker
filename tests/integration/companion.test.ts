import { it, expect, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { PlayerCompanion } from "../../apps/player-agent/src/companion.ts";
import { SimulatedFiberNetwork } from "@fiber-poker/fiber-adapter";
import { generateKeyPair } from "@fiber-poker/protocol";

function message(
  socket: WebSocket,
  type: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", receive);
      reject(new Error(`missing ${type}`));
    }, 3000);
    const receive = (data: { toString(): string }) => {
      const m = JSON.parse(data.toString());
      if (m.type === type) {
        clearTimeout(timer);
        socket.off("message", receive);
        resolve(m);
      }
    };
    socket.on("message", receive);
  });
}
for (const enabled of [false, true])
  it(`companion transport enforces identity/origin and payment opt-in (${enabled})`, async () => {
    const net = new SimulatedFiberNetwork();
    const [tableNode, playerNode] = net.addRandomNodes(2, 100_000_000_000n);
    const payer = net.node(playerNode),
      payee = net.node(tableNode);
    await payer.openChannel(tableNode, 15_000_000_000n);
    const pay = vi.spyOn(payer, "payInvoice");
    const owner = generateKeyPair((n) =>
      crypto.getRandomValues(new Uint8Array(n)),
    );
    const table = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => table.once("listening", resolve));
    const address = table.address();
    if (!address || typeof address === "string") throw new Error();
    const relay = new PlayerCompanion({
      tableUrl: `ws://127.0.0.1:${address.port}`,
      playerId: owner.publicKey,
      gateway: payer,
      port: 0,
      allowedOrigins: ["http://localhost:5173"],
      payInvoices: enabled,
    });
    await relay.start();
    let browser: WebSocket | undefined;
    try {
      const badOrigin = new WebSocket(`ws://127.0.0.1:${relay.port}`, {
        origin: "https://unrelated.example",
      });
      await expect(
        new Promise((resolve, reject) => {
          badOrigin.once("open", resolve);
          badOrigin.once("error", reject);
        }),
      ).rejects.toThrow("403");
      const wrong = new WebSocket(`ws://127.0.0.1:${relay.port}`, {
        origin: "http://localhost:5173",
      });
      await new Promise<void>((resolve) => wrong.once("open", resolve));
      const error = message(wrong, "ERROR");
      const closed = new Promise<void>((resolve) =>
        wrong.once("close", () => resolve()),
      );
      wrong.send(
        JSON.stringify({ type: "HELLO", payload: { pubkey: "wrong-key" } }),
      );
      expect((await error).payload).toMatchObject({
        code: "COMPANION_KEY_MISMATCH",
      });
      await closed;
      const connected = new Promise<WebSocket>((resolve) =>
        table.once("connection", resolve),
      );
      browser = new WebSocket(`ws://127.0.0.1:${relay.port}`, {
        origin: "http://localhost:5173",
      });
      await new Promise<void>((resolve) => browser!.once("open", resolve));
      browser.send(
        JSON.stringify({ type: "HELLO", payload: { pubkey: owner.publicKey } }),
      );
      const upstream = await connected;
      // The real table authenticates in the browser test; here exercise relay boundaries.
      const ready = message(browser, "COMPANION_STATUS");
      upstream.send(JSON.stringify({ type: "WELCOME", payload: {} }));
      expect((await ready).payload).toMatchObject({
        status: enabled ? "READY" : "OBSERVE_ONLY",
      });
      const joined = message(upstream, "JOIN_TABLE");
      browser.send(
        JSON.stringify({
          type: "JOIN_TABLE",
          payload: { buyInShannons: "100", fiberPeerPubkey: "wrong-peer" },
        }),
      );
      expect((await joined).payload).toMatchObject({
        fiberPeerPubkey: playerNode,
      });
      const action = {
        type: "ACTION",
        payload: {
          envelope: {
            signature: "opaque-test-signature",
            amountShannons: "123456789",
            actionType: "BET",
          },
        },
      };
      const forwarded = message(upstream, "ACTION");
      browser.send(JSON.stringify(action));
      expect(await forwarded).toEqual(action);
      const invoice = await payee.createInvoice(100n);
      const req = {
        type: "PAYMENT_REQUIRED",
        payload: {
          obligationId: "test-obligation",
          invoiceAddress: invoice.invoiceAddress,
          direction: "PLAYER_TO_TABLE",
        },
      };
      const observed = message(
        browser,
        enabled ? "COMPANION_STATUS" : "PAYMENT_REQUIRED",
      );
      upstream.send(JSON.stringify(req));
      upstream.send(JSON.stringify(req));
      await observed;
      await vi.waitFor(() =>
        expect(pay).toHaveBeenCalledTimes(enabled ? 1 : 0),
      );
      expect(await payee.invoiceStatus(invoice.paymentHash)).toBe(
        enabled ? "Paid" : "Open",
      );
      const switched = message(browser, "ERROR");
      browser.send(JSON.stringify({ type: "HELLO", payload: { pubkey: "different-identity" } }));
      expect((await switched).payload).toMatchObject({ code: "COMPANION_KEY_MISMATCH" });
    } finally {
      browser?.terminate();
      await relay.stop();
      for (const socket of table.clients) socket.terminate();
      await new Promise<void>((resolve) => table.close(() => resolve()));
    }
  });
