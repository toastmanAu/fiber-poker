import { test, expect } from "@playwright/test";
import {
  startTestServer,
  K,
} from "../../../tests/integration/helpers/server.ts";
import { TestClient } from "../../../tests/integration/helpers/client.ts";
import { engine } from "@fiber-poker/poker-engine";
import { generateKeyPair } from "@fiber-poker/protocol";

for (const count of [2, 6])
  test(`${count} players: live committed table, mobile resize, private cards and legal actions`, async ({
    page,
  }, testInfo) => {
    const { server, url, adapter } = await startTestServer({
      autoStartHands: false,
      turnTimeoutMs: 60_000,
    });
    const bots: TestClient[] = [];
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      for (let i = 0; i < count - 1; i++) {
        const bot = new TestClient(
          generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n))),
          `browser-bot-${i}`,
        );
        await bot.connect(url);
        await bot.joinTable(BigInt(100 - i * 10) * K);
        bots.push(bot);
      }
      await page.goto("/");
      await page.locator("#ws-url").fill(url);
      await page.locator("#btn-join").click();
      await expect(page.locator(".player-label:not(.empty)")).toHaveCount(
        count,
      );
      await expect(page.locator(".player-label.local")).toHaveAttribute(
        "data-slot",
        "0",
      );
      await expect(page.locator("#status-chips")).toContainText(
        "FAKE SETTLEMENT",
      );
      await server.maybeStartHand();
      await expect(page.locator("#hand-info")).toContainText("PREFLOP");
      // Follow actual server turns; no synthetic application state or renderer fixtures.
      for (let i = 0; i < count + 2; i++) {
        const actor =
          server.runtime.state.seats[server.runtime.state.actingSeat!]
            ?.playerId;
        if (!actor) break;
        const bot = bots.find((b) => b.id === actor);
        if (!bot) break;
        await bot.waitFor(
          "YOUR_TURN",
          5000,
          (m) =>
            BigInt((m.payload as { sequence: string }).sequence) ===
            server.runtime.tip.sequence + 1n,
        );
        const legal = engine().legalActions(server.runtime.state, actor)!;
        await bot.act({
          type: legal.actions.some(action => action === "CHECK") ? "CHECK" : "CALL",
        });
      }
      await expect(page.locator("#action-status")).toContainText("Your turn");
      await expect(page.locator("#btn-fold")).toBeEnabled();
      await expect(page.locator("#table-details")).not.toContainText(
        "Your cards: Not received",
      );
      await expect(page.locator("#btn-fold")).toBeInViewport();
      await page.waitForTimeout(800);
      await page.screenshot({
        path: testInfo.outputPath(`table-${count}-portrait.png`),
      });
      await page.setViewportSize({ width: 360, height: 740 });
      await expect(page.locator(".player-label.local")).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      expect(overflow).toBe(false);
      await page.setViewportSize({ width: 844, height: 390 });
      await page.screenshot({
        path: testInfo.outputPath(`table-${count}-landscape.png`),
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({
        path: testInfo.outputPath(`table-${count}-desktop.png`),
      });
      await page.locator("#btn-details").click();
      await expect(page.locator("#journal")).toBeVisible();
      await expect(page.locator("#chain-details")).not.toContainText(
        "CHAIN BROKEN",
      );
      await page.keyboard.press("Escape");
      const botStep = async (aggressive = false) => {
        const actor =
          server.runtime.state.seats[server.runtime.state.actingSeat!]
            ?.playerId;
        const bot = bots.find((b) => b.id === actor);
        if (!bot || !actor) return false;
        await bot.waitFor(
          "YOUR_TURN",
          5000,
          (m) =>
            BigInt((m.payload as { sequence: string }).sequence) ===
            server.runtime.tip.sequence + 1n,
        );
        const legal = engine().legalActions(server.runtime.state, actor)!;
        const type = aggressive
          ? "ALL_IN"
          : legal.actions.some(action => action === "CHECK")
            ? "CHECK"
            : "CALL";
        const seq = server.runtime.tip.sequence;
        await bot.act({ type });
        await expect.poll(() => server.runtime.tip.sequence > seq).toBe(true);
        return true;
      };
      if (count === 2) {
        const stack = await page.locator(".local .player-stack").textContent();
        const seq = server.runtime.tip.sequence;
        adapter.defaultMode = "permanent-fail";
        await page.locator("#btn-raise").click();
        await expect(page.locator("#payment-status")).toContainText(
          "Payment failed",
          { timeout: 10000 },
        );
        expect(server.runtime.tip.sequence).toBe(seq);
        await expect(page.locator(".local .player-stack")).toHaveText(stack!);
        adapter.defaultMode = "late-success";
        let obligation = "";
        adapter.onPaymentRequest(
          (req) => (obligation = req.obligation.obligationId),
        );
        await page.locator("#btn-raise").click();
        await expect(page.locator("#payment-status")).toContainText(
          "Fiber payment pending",
        );
        await page.waitForTimeout(1500); // The former artificial completion timer must not unlock controls.
        await expect(page.locator("#btn-raise")).toBeDisabled();
        await expect(page.locator(".local .player-stack")).toHaveText(stack!);
        expect(server.runtime.tip.sequence).toBe(seq);
        adapter.defaultMode = "success";
        adapter.release(obligation);
        await expect.poll(() => server.runtime.tip.sequence > seq).toBe(true);
        await botStep();
        await expect(page.locator("#hand-info")).toContainText("FLOP");
        await expect(page.locator("#btn-raise")).toHaveText("Bet");
        await expect(page.locator("#btn-raise")).toBeEnabled();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(800);
        await page.screenshot({
          path: testInfo.outputPath("flop-portrait.png"),
        });
        const flopSeq = server.runtime.tip.sequence;
        await page.locator("#btn-raise").click(); // The server only advertises BET here.
        await expect
          .poll(() => server.runtime.tip.sequence > flopSeq)
          .toBe(true);
        await botStep();
        await expect(page.locator("#hand-info")).toContainText("TURN");
        for (const street of ["TURN", "RIVER"]) {
          await expect(page.locator("#hand-info")).toContainText(street);
          await expect(page.locator("#btn-check")).toBeEnabled();
          const seq = server.runtime.tip.sequence;
          await page.locator("#btn-check").click();
          await expect.poll(() => server.runtime.tip.sequence > seq).toBe(true);
          await botStep();
        }
        await expect
          .poll(() => server.runtime.state.phase)
          .toBe("HAND_COMPLETE");
        await expect(page.locator("#deck-audit")).toContainText(
          "Dealing: verified",
        );
        await page.locator("#btn-details").click();
        await page.screenshot({
          path: testInfo.outputPath("verified-deck-audit.png"),
        });
        await page.keyboard.press("Escape");
        // Reload reconnects the same identity; snapshots restore public state without invented legal actions.
        await page.reload();
        await page.locator("#ws-url").fill(url);
        await page.locator("#btn-join").click();
        await expect(page.locator(".player-label.local")).toBeVisible();
        await expect(page.locator("#chain-alert")).toBeHidden();
      } else {
        await page.locator("#btn-fold").click();
        await expect(page.locator("#action-status")).not.toContainText(
          "Your turn",
        );
        for (
          let i = 0;
          i < 12 && server.runtime.state.actingSeat !== undefined;
          i++
        )
          await botStep(true);
        await expect
          .poll(() => server.runtime.state.phase)
          .toBe("HAND_COMPLETE");
        await expect(page.locator("#deck-audit")).toContainText(
          "Dealing: verified",
        );
        await bots[0]!.leave();
        await expect(page.locator(".player-label:not(.empty)")).toHaveCount(5);
        bots[1]!.sendRaw("SIT_OUT", {});
        await expect(
          page.locator(".player-detail").filter({ hasText: "Sitting out" }),
        ).toHaveCount(1);
      }
      expect(errors).toEqual([]);
    } finally {
      for (const bot of bots) bot.close();
      await page.close();
      await server.stop();
    }
  });

test("server timeout and in-place reconnect follow authoritative snapshots", async ({
  page,
}) => {
  const { server, url } = await startTestServer({
    autoStartHands: false,
    turnTimeoutMs: 5000,
  });
  const bot = new TestClient(
    generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n))),
    "timeout-bot",
  );
  try {
    // Test-only socket observation; no production debugging hooks.
    await page.addInitScript(() => {
      const NativeSocket = window.WebSocket;
      window.WebSocket = class extends NativeSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          (window as unknown as { testSocket: WebSocket }).testSocket = this;
        }
      };
    });
    await bot.connect(url);
    await bot.joinTable(100n * K);
    await page.goto("/");
    await page.locator("#ws-url").fill(url);
    await page.locator("#btn-join").click();
    await expect(page.locator(".player-label:not(.empty)")).toHaveCount(2);
    await server.maybeStartHand();
    await bot.waitFor("YOUR_TURN");
    await bot.act({ type: "CALL" });
    await expect(page.locator("#btn-check")).toBeEnabled();
    await expect(page.locator("#turn-clock")).toContainText("s");
    const before = server.runtime.tip.sequence;
    await expect
      .poll(() => server.runtime.tip.sequence > before, { timeout: 10000 })
      .toBe(true);
    await expect(page.locator("#hand-info")).toContainText("FLOP");
    await page.evaluate(() =>
      (window as unknown as { testSocket: WebSocket }).testSocket.close(),
    );
    await expect(page.locator("#status-chips")).toContainText("Reconnecting");
    await expect(page.locator("#btn-check")).toBeDisabled();
    await expect(page.locator("#status-chips")).not.toContainText(
      "Reconnecting",
      { timeout: 10000 },
    );
    await expect(page.locator("#status-chips")).toContainText("Authenticated");
    await expect(page.locator("#chain-alert")).toBeHidden();
    await expect(page.locator(".player-label.local")).toBeVisible();
  } finally {
    bot.close();
    await page.close();
    await server.stop();
  }
});
