import { expect, it } from "vitest";
import { generateKeyPair } from "@fiber-poker/protocol";
import { parseAgentIdentity } from "../../apps/web-client/src/identity.ts";
it("validates an imported poker identity and rejects credential/config files", () => {
  const key = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
  expect(parseAgentIdentity(JSON.stringify(key))).toEqual(key);
  expect(() =>
    parseAgentIdentity(
      JSON.stringify({ ...key, fnnToken: "not-a-real-token" }),
    ),
  ).toThrow();
  expect(() =>
    parseAgentIdentity(JSON.stringify({ ...key, privateKey: "0".repeat(64) })),
  ).toThrow();
  expect(() => parseAgentIdentity("not-json")).toThrow();
  expect(() => parseAgentIdentity("x".repeat(2049))).toThrow();
});
