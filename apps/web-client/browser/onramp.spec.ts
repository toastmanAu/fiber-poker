/**
 * Browser on-ramp UI: the "New player" button requests the identity the
 * companion generated (--generate-identity) and imports it into the tab —
 * no identity file needed. Transport-level guarantees are covered by
 * tests/integration/onramp.test.ts.
 */

import { test, expect } from "@playwright/test";
import { WebSocketServer } from "ws";
import { PlayerCompanion } from "../../player-agent/src/companion.ts";
import { generateKeyPair } from "@fiber-poker/protocol";

test("new player generates an identity through the companion UI flow", async ({
  page,
}) => {
  const identity = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
  const table = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => table.once("listening", resolve));
  const address = table.address();
  if (!address || typeof address === "string") throw new Error();

  // No gateway: this spec exercises identity generation only (no payments).
  const stubGateway = {
    nodePubkey: async () => "02stub",
  } as unknown as Parameters<typeof PlayerCompanion>[0]["gateway"];
  const companion = new PlayerCompanion({
    tableUrl: `ws://127.0.0.1:${address.port}`,
    playerId: identity.publicKey,
    port: 0,
    allowedOrigins: ["http://127.0.0.1:5175"],
    generatedIdentity: identity,
    gateway: stubGateway,
  });
  await companion.start();

  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  try {
    await page.goto("/");
    await page.locator("#ws-url").fill(`ws://127.0.0.1:${companion.port}`);
    await page.locator(".identity-options summary").click();
    await page.locator("#btn-generate-identity").click();
    await expect(page.locator("#identity-status")).toContainText(
      "Companion-generated identity",
    );
    await expect(page.locator("#identity-status")).toContainText(
      identity.publicKey.slice(0, 6),
    );
    // Connecting + joining from here needs no identity file: the session
    // HELLOs with the generated key and the companion matches it.
    await expect(pageErrors).toEqual([]);
  } finally {
    await page.close();
    await companion.stop();
    table.close();
  }
});
