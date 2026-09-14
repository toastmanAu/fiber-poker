import { test, expect } from "@playwright/test";
import { SimulatedFiberNetwork } from "@fiber-poker/fiber-adapter";
import { ImmediateFiberSettlement } from "@fiber-poker/settlement";
import { TableServer } from "@fiber-poker/table-server";
import {
  InMemoryEventStore,
  InMemorySnapshotStore,
} from "@fiber-poker/persistence";
import { generateKeyPair } from "@fiber-poker/protocol";
import { PlayerCompanion } from "../../player-agent/src/companion.ts";
import { TestClient } from "../../../tests/integration/helpers/client.ts";

const K = 100_000_000n;
const key = () =>
  generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));

test("browser imports agent identity and plays through a simulated Fiber companion", async ({
  page,
}) => {
  const net = new SimulatedFiberNetwork();
  const [tableNode, playerNode] = net.addRandomNodes(2, 1_000_000n * K);
  const tableGateway = net.node(tableNode),
    playerGateway = net.node(playerNode);
  await playerGateway.openChannel(tableNode, 150n * K);
  await tableGateway.fundChannelTo(playerNode, 300n * K);
  const browserKey = key(),
    botKey = key();
  const adapter = new ImmediateFiberSettlement(tableGateway, {
    pollMs: 25,
    timeoutMs: 30000,
    resolvePeer: () => playerNode,
  });
  adapter.onPaymentRequest((req) => {
    if (req.obligation.playerId === botKey.publicKey && req.invoiceAddress)
      void playerGateway.payInvoice!(req.invoiceAddress);
  });
  const server = new TableServer(
    {
      port: 0,
      autoStartHands: false,
      turnTimeoutMs: 60000,
      peerMapJson: JSON.stringify({ [botKey.publicKey]: playerNode }),
    },
    {
      gateway: tableGateway,
      adapter,
      events: new InMemoryEventStore(),
      snapshots: new InMemorySnapshotStore(),
      keys: key(),
    },
  );
  await server.start();
  let release: (() => void) | undefined;
  let delay = false;
  let invoices = 0;
  const payer = Object.create(playerGateway) as typeof playerGateway;
  payer.payInvoice = async (invoice) => {
    invoices++;
    if (delay) await new Promise<void>((resolve) => (release = resolve));
    return playerGateway.payInvoice!(invoice);
  };
  const companion = new PlayerCompanion({
    tableUrl: `ws://127.0.0.1:${server.port}`,
    playerId: browserKey.publicKey,
    gateway: payer,
    port: 0,
    allowedOrigins: ["http://127.0.0.1:5175"],
    payInvoices: true,
  });
  const bot = new TestClient(botKey, "companion-test-bot");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await companion.start();
    await bot.connect(`ws://127.0.0.1:${server.port}`);
    await bot.joinTable(10n * K);
    await page.goto("/");
    await page.locator(".identity-options summary").click();
    await page
      .locator("#agent-identity")
      .setInputFiles({
        name: "test.session.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(browserKey)),
      });
    await expect(page.locator("#identity-status")).toContainText(
      "kept only in this tab",
    );
    await page.locator("#ws-url").fill(`ws://127.0.0.1:${companion.port}`);
    await page.locator("#buy-in").fill("10");
    await page.locator("#btn-join").click();
    await expect(page.locator(".player-label:not(.empty)")).toHaveCount(2);
    await expect(page.locator("#status-chips")).toContainText(
      "Local companion connected",
    );
    await expect(page.locator("#status-chips")).not.toContainText(
      "FAKE SETTLEMENT",
    );
    expect(
      await page.evaluate(() => localStorage.getItem("fiber-poker-key")),
    ).toBeNull();
    expect(invoices).toBeGreaterThan(0);
    await server.maybeStartHand();
    await bot.waitFor("YOUR_TURN");
    await bot.act({ type: "CALL" });
    await expect(page.locator("#btn-raise")).toBeEnabled();
    const before = server.runtime.tip.sequence;
    const stack = await page.locator(".local .player-stack").textContent();
    delay = true;
    await page.locator("#btn-raise").click();
    await expect(page.locator("#payment-status")).toContainText(
      "Fiber payment pending",
    );
    await expect(page.locator("#history")).toContainText(
      "Companion submitting invoice",
    );
    await expect(page.locator("#btn-raise")).toBeDisabled();
    expect(server.runtime.tip.sequence).toBe(before);
    await expect(page.locator(".local .player-stack")).toHaveText(stack!);
    delay = false;
    release?.();
    await expect.poll(() => server.runtime.tip.sequence > before).toBe(true);
    await expect(page.locator("#payment-status")).not.toContainText("pending");
    await expect(page.locator(".local .player-stack")).not.toHaveText(stack!);
    await expect(page.locator("#chain-alert")).toBeHidden();
    expect(errors).toEqual([]);

    // --- between-hands seat controls: top-up, then cash out -----------------
    // End the live hand so the browser seat is between hands.
    const botTurn = await bot.waitFor("YOUR_TURN", 15000).catch(() => null);
    if (botTurn) await bot.act({ type: "FOLD" });
    await expect
      .poll(() => server.runtime.state.phase, { timeout: 30000 })
      .toMatch(/HAND_COMPLETE|WAITING/);

    // Top-up settles through the simulated fiber and lands on the stack.
    const stackBefore = await page
      .locator(".local .player-stack")
      .textContent();
    await page.locator("#top-up").fill("5");
    await page.locator("#btn-topup").click();
    await expect(page.locator("#history")).toContainText("Top-up applied");
    await expect
      .poll(async () => {
        return page.locator(".local .player-stack").textContent();
      })
      .not.toBe(stackBefore);

    // Cash out: payout over the channel, seat removed, back to the join screen.
    await page.locator("#btn-leave").click();
    await expect(page.locator("#join-status")).toContainText(
      "paid out over your channel",
    );
    await expect.poll(() => server.seatRecords().length).toBe(1); // only the bot
  } finally {
    release?.();
    bot.close();
    await page.close();
    await companion.stop();
    await server.stop();
  }
});
