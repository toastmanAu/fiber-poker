import { describe, expect, it } from "vitest";

import {
  actionHash,
  checkEnvelopeAgainstTip,
  signHash,
  envelopeToEngineAction,
  genesisStateHash,
  generateKeyPair,
  makeMessage,
  nextStateHash,
  publicView,
  verifyEnvelopeSignature,
  verifyStateHash,
  type ActionEnvelope,
} from "@fiber-poker/protocol";
import { createTableState, DEFAULT_CONFIG, fullDeck, type TableState } from "@fiber-poker/poker-engine";
import { E } from "../../packages/poker-engine/test/harness.ts";

const alice = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
const bob = generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));

function tip(): { sequence: bigint; stateHash: string; tableId: string } {
  return { sequence: 7n, stateHash: "ab".repeat(32), tableId: "table-1" };
}

function envelope(overrides: Partial<ActionEnvelope> = {}): ActionEnvelope {
  const base: ActionEnvelope = {
    protocolVersion: 1,
    tableId: "table-1",
    handId: "hand-9",
    sequence: "7",
    previousStateHash: "ab".repeat(32),
    actorPubkey: alice.publicKey,
    actionType: "RAISE",
    amountShannons: "400000000",
    nonce: "n-1234567890abcdef",
    signature: "",
  };
  const env = { ...base, ...overrides };
  // Sign with (possibly overridden) fields; tamper tests then re-sign or not.
  env.signature = signHash(alice.privateKey, actionHash(env));
  return env;
}

function handState(): TableState {
  let s = createTableState("table-1", DEFAULT_CONFIG);
  for (const [i, kp] of [alice, bob].entries()) {
    const r = E.reduce(s, { type: "SIT_DOWN", playerId: kp.publicKey, fiberPubkey: kp.publicKey, seat: i, buyIn: 100n * 100_000_000n });
    if (!r.ok) throw new Error(r.error.code);
    s = r.transition.nextState;
  }
  const start = E.reduce(s, { type: "START_HAND", handId: "hand-9", deck: fullDeck(), deckCommitment: "c" });
  if (!start.ok) throw new Error(start.error.code);
  s = start.transition.nextState;
  // Heads-up: alice (button/SB) posts, then bob (BB); reaches PREFLOP with cards.
  const sb = E.reduce(s, { type: "POST_BLIND", playerId: alice.publicKey });
  if (!sb.ok) throw new Error(sb.error.code);
  const bb = E.reduce(sb.transition.nextState, { type: "POST_BLIND", playerId: bob.publicKey });
  if (!bb.ok) throw new Error(bb.error.code);
  return bb.transition.nextState;
}

describe("action envelopes", () => {
  it("verifies a correctly signed action", () => {
    const env = envelope();
    expect(verifyEnvelopeSignature(env)).toBe(true);
  });

  it("rejects signature by the wrong key", () => {
    const env = envelope();
    // Signed by Alice, attributed to Bob.
    const forged = { ...env, actorPubkey: bob.publicKey };
    expect(verifyEnvelopeSignature(forged)).toBe(false);
  });

  it("rejects tampered fields (hash binding)", () => {
    const env = envelope();
    for (const tamper of [
      (e: ActionEnvelope) => ({ ...e, amountShannons: "500000000" }),
      (e: ActionEnvelope) => ({ ...e, actionType: "CALL" }),
      (e: ActionEnvelope) => ({ ...e, handId: "hand-10" }),
      (e: ActionEnvelope) => ({ ...e, nonce: "n-ffffffffffffffff" }),
      (e: ActionEnvelope) => ({ ...e, sequence: "8" }),
    ]) {
      expect(verifyEnvelopeSignature(tamper(env)), JSON.stringify(tamper(env))).toBe(false);
    }
  });

  it("is deterministic: identical fields produce identical hashes", () => {
    expect(actionHash(envelope())).toEqual(actionHash(envelope()));
  });

  it("maps envelopes to engine actions", () => {
    const a = envelopeToEngineAction(envelope());
    expect(a).toEqual({ type: "RAISE", playerId: alice.publicKey, amount: 400000000n });
  });
});

describe("replay protection", () => {
  it("accepts the exact next sequence", () => {
    expect(checkEnvelopeAgainstTip(envelope(), tip())).toBeUndefined();
  });

  it("rejects stale (replayed) sequences", () => {
    const env = envelope({ sequence: "6" });
    expect(checkEnvelopeAgainstTip(env, tip())).toBe("STALE_SEQUENCE");
  });

  it("rejects sequence gaps", () => {
    const env = envelope({ sequence: "8" });
    expect(checkEnvelopeAgainstTip(env, tip())).toBe("SEQUENCE_GAP");
  });

  it("rejects wrong previous state hash", () => {
    const env = envelope({ previousStateHash: "cd".repeat(32) });
    expect(checkEnvelopeAgainstTip(env, tip())).toBe("WRONG_PREVIOUS_STATE_HASH");
  });

  it("rejects wrong table and protocol version", () => {
    expect(checkEnvelopeAgainstTip(envelope({ tableId: "other" }), tip())).toBe("WRONG_TABLE");
    expect(checkEnvelopeAgainstTip(envelope({ protocolVersion: 2 }), tip())).toBe("BAD_PROTOCOL_VERSION");
  });
});

describe("state hash chain", () => {
  it("chains genesis -> action deterministically and verifies", () => {
    const s0 = handState();
    const g = genesisStateHash(publicView(s0));
    expect(g).toMatch(/^[0-9a-f]{64}$/);
    expect(genesisStateHash(publicView(s0))).toBe(g);

    const env = envelope();
    const r = E.reduce(s0, envelopeToEngineAction(env));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const h1 = nextStateHash(g, Buffer.from(actionHash(env)).toString("hex"), publicView(r.transition.nextState));
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(
      verifyStateHash(g, Buffer.from(actionHash(env)).toString("hex"), h1, publicView(r.transition.nextState)),
    ).toBe(true);
    // Tamper: different action hash breaks verification.
    expect(
      verifyStateHash(g, "ff".repeat(32), h1, publicView(r.transition.nextState)),
    ).toBe(false);
  });

  it("keeps hole cards out of the public view but commits them", () => {
    const s = handState();
    const view = publicView(s);
    for (const seat of view.seats) {
      if (!seat.playerId) {
        expect(seat.holeCardsHash).toBeUndefined();
        continue;
      }
      expect(seat.holeCardsHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(JSON.stringify(view)).not.toContain('"holeCards"');
  });

  it("changes the public view when acting seat changes (chain sensitivity)", () => {
    const s0 = handState();
    const g = genesisStateHash(publicView(s0));
    const env = envelope();
    const r = E.reduce(s0, envelopeToEngineAction(env));
    if (!r.ok) throw new Error(r.error.code);
    const h1 = nextStateHash(g, Buffer.from(actionHash(env)).toString("hex"), publicView(r.transition.nextState));
    // A different actionHash yields a different chain hash.
    const h1b = nextStateHash(g, "11".repeat(32), publicView(r.transition.nextState));
    expect(h1).not.toBe(h1b);
  });
});

describe("ws messages", () => {
  it("creates schema-shaped messages", () => {
    const m = makeMessage("STATE_COMMIT", { sequence: "1" }, { tableId: "t", sequence: "1" });
    expect(m.protocolVersion).toBe(1);
    expect(m.messageId).toBeTruthy();
    expect(m.payload).toEqual({ sequence: "1" });
  });
});
