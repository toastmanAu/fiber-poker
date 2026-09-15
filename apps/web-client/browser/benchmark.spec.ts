/**
 * Browser-engine benchmark for the hardened mental-poker deal (P11).
 *
 * Runs the 2048-bit safe-prime joint deal inside real Chromium via the
 * vite dev server, so the recorded number is the actual browser-engine
 * cost (same engine class as the web client; WebKit/Gecko differ).
 * Import path uses vite's /@fs/ pipeline against the deck source.
 */

import { test } from "@playwright/test";

test("2048-bit mental poker deal inside Chromium", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  const ms = await page.evaluate(async () => {
    const deck = await import(
      "/@fs/home/phill/fiber-poker/fiber-poker/packages/deck/src/index.ts"
    );
    const deal = new deck.MentalPokerDeal(["chromium-a", "chromium-b"]);
    const started = performance.now();
    deal.jointEncrypt();
    while (deal.poolSize() > 0) {
      deal.dealTo(deal.poolSize() % 2 === 0 ? "chromium-b" : "chromium-a");
    }
    return Math.round(performance.now() - started);
  });
  console.log(`[benchmark:chromium] full 52-card deal (2 players, 2048-bit prime): ${ms}ms`);
});
