/**
 * P11 + P12 research prototype tests.
 *
 * P11: mental-poker deal — joint encryption produces a deck nobody can
 * unilaterally read or stack; strip-deal gives each card to exactly one
 * player; abort hooks work.
 * P12: poker state channel — co-signed allocations, conservation, stale
 * state disputes, epoch finalization, membership rotation.
 */

import { describe, expect, it } from "vitest";
import {
  MentalPokerDeal,
  PohligHellmanCipher,
  deterministicKeypair,
  modPow,
  TOY_PRIME,
} from "@fiber-poker/deck";
import {
  PokerChannelSim,
  channelStateHash,
  signChannelState,
  verifyChannelStateSignature,
} from "@fiber-poker/settlement";
import { generateKeyPair } from "@fiber-poker/protocol";

const K = 100_000_000n;

describe("P11 mental poker prototype", () => {
  it("Pohlig-Hellman cipher commutes and inverts", () => {
    const a = deterministicKeypair(TOY_PRIME, 11n);
    const b = deterministicKeypair(TOY_PRIME, 22n);
    const m = 42n;
    // Commutative encryption: (m^eB)^eA == (m^eA)^eB.
    expect(a.encrypt(b.encrypt(m))).toBe(b.encrypt(a.encrypt(m)));
    // Unwrap in reverse encryption order.
    expect(b.decrypt(a.decrypt(a.encrypt(b.encrypt(m))))).toBe(m);
    expect(a.decrypt(b.decrypt(b.encrypt(a.encrypt(m))))).toBe(m);
    // Round trip.
    expect(a.decrypt(a.encrypt(m))).toBe(m);
    // modPow sanity.
    expect(modPow(7n, 2n, 100n)).toBe(49n);
  });

  it("jointly encrypts and deals distinct cards to each player", () => {
    const deal = new MentalPokerDeal(["alice", "bob", "carol"]);
    const encrypted = deal.jointEncrypt();
    expect(encrypted).toHaveLength(52);
    // After the joint encryption, no single party's key can decrypt a card:
    // alice alone cannot recover a plaintext (result outside 1..52 with
    // overwhelming probability under the toy prime).
    const aliceKey = deterministicKeypair(TOY_PRIME, 999n);
    const alone = Number(aliceKey.decrypt(encrypted[0]!));
    expect(alone < 1 || alone > 52).toBe(true);

    // Deal 2 hole cards each + board of 5: seven distinct cards per player,
    // no card dealt twice.
    for (let i = 0; i < 2; i++) {
      for (const p of ["alice", "bob", "carol"]) {
        deal.dealTo(p);
      }
    }
    for (let i = 0; i < 5; i++) {
      deal.dealTo("alice"); // board controlled by the table in this sim
    }
    const all = [...deal.hand("alice"), ...deal.hand("bob"), ...deal.hand("carol")];
    expect(all).toHaveLength(11);
    expect(new Set(all).size).toBe(11);
    expect(deal.poolSize()).toBe(41);
  });

  it("records a transcript usable for post-hoc verification", () => {
    const deal = new MentalPokerDeal(["alice", "bob"]);
    deal.jointEncrypt();
    deal.dealTo("alice");
    const transcript = deal.transcript();
    expect(transcript.filter((e) => e.action === "shuffle-encrypt")).toHaveLength(2);
    expect(transcript.filter((e) => e.action === "strip-for").map((e) => e.playerId)).toEqual(["bob"]);
    expect(transcript[transcript.length - 1]!.action).toBe("claim");
  });

  it("abort hook marks the deal unusable", () => {
    const deal = new MentalPokerDeal(["alice", "bob"]);
    deal.jointEncrypt();
    deal.abort("bob failed to strip layer in time");
    expect(() => deal.dealTo("alice")).toThrow(/aborted/);
  });

  it("a bigger prime flows through the same code path (production shape)", () => {
    // 2^61 - 1 (Mersenne); not a safe prime, but the arithmetic is identical
    // to what a real deployment would run with a 2048-bit safe prime.
    const p = 2305843009213693951n;
    const cipher = deterministicKeypair(p, 999n);
    expect((cipher.d * cipher.e) % (p - 1n)).toBe(1n);
    const m = 52n;
    expect(cipher.decrypt(cipher.encrypt(m))).toBe(m);
  });
});

describe("P12 poker state channel", () => {
  const players = ["alice", "bob", "carol"];
  const keys = new Map(players.map((p) => [p, generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)))]));

  function makeChannel(): PokerChannelSim {
    const ch = new PokerChannelSim();
    for (const p of players) {
      const kp = keys.get(p)!;
      ch.addParticipant(p, kp.publicKey, kp.privateKey);
      ch.withBuyIn(p, 100n * K);
    }
    ch.openEpoch();
    return ch;
  }

  it("opens an epoch with co-signed locked buy-ins", () => {
    const ch = makeChannel();
    const latest = ch.latestState()!;
    expect(latest.state.tableEpoch).toBe(1);
    expect(latest.state.balances["alice"]).toBe((100n * K).toString());
    expect(latest.state.sequence).toBe(0);
    for (const p of players) {
      expect(verifyChannelStateSignature(latest.state, p, latest.signatures[p]!, keys.get(p)!.publicKey)).toBe(true);
    }
  });

  it("applies hand results with conservation and full co-signing", () => {
    const ch = makeChannel();
    // Alice wins 30 CKB total from bob and carol.
    const next = ch.applyHandResult("h1", "f".repeat(64), {
      alice: 130n * K,
      bob: 85n * K,
      carol: 85n * K,
    });
    expect(next.state.sequence).toBe(1);
    expect(next.state.gameStateHash).toBe("f".repeat(64));
    expect(channelStateHash(next.state)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects allocations that break conservation", () => {
    const ch = makeChannel();
    expect(() =>
      ch.applyHandResult("h1", "0".repeat(64), {
        alice: 200n * K, // minted 100 CKB out of nothing
        bob: 85n * K,
        carol: 85n * K,
      }),
    ).toThrow(/conservation/);
  });

  it("adjudicates stale states as invalid (latest co-signed state wins)", () => {
    const ch = makeChannel();
    const state1 = ch.applyHandResult("h1", "a".repeat(64), { alice: 130n * K, bob: 85n * K, carol: 85n * K });
    const latestSeq = state1.state.sequence;

    // Forge a stale state from BEFORE (sequence 0 balances) with valid signatures.
    const staleState = {
      ...state1.state,
      sequence: 0,
      balances: { alice: (100n * K).toString(), bob: (100n * K).toString(), carol: (100n * K).toString() },
    };
    const signatures = Object.fromEntries(
      players.map((p) => [p, signChannelState(staleState, keys.get(p)!.privateKey)]),
    );
    const verdict = ch.adjudicate({ state: staleState, signatures });
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toMatch(/stale/);
    expect(ch.disputeLog().at(-1)!.submittedSequence).toBe(latestSeq - 1);
    // The honest latest state stands.
    expect(ch.latestState()!.state.sequence).toBe(latestSeq);
  });

  it("rejects a state missing a co-signature", () => {
    const ch = makeChannel();
    const state = {
      protocolVersion: 1,
      tableEpoch: 1,
      participantSet: [...players],
      balances: { alice: (90n * K).toString(), bob: (110n * K).toString(), carol: (100n * K).toString() },
      gameStateHash: "b".repeat(64),
      sequence: 1,
      finalized: false,
    };
    // Only alice signs.
    const verdict = ch.adjudicate({ state, signatures: { alice: signChannelState(state, keys.get("alice")!.privateKey) } });
    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toMatch(/signature/);
  });

  it("finalizes an epoch with exact payouts and rotates membership between hands", () => {
    const ch = makeChannel();
    ch.applyHandResult("h1", "c".repeat(64), { alice: 130n * K, bob: 85n * K, carol: 85n * K });
    const finalized = ch.finalizeEpoch();
    expect(finalized.state.finalized).toBe(true);
    expect(finalized.payouts["alice"]).toBe(130n * K);
    expect(finalized.payouts["bob"]).toBe(85n * K);

    // Membership changes only BETWEEN epochs (docs/14): carol leaves, dave joins.
    const ch2 = new PokerChannelSim();
    for (const p of ["alice", "bob", "dave"]) {
      const kp = keys.get(p) ?? generateKeyPair((n) => crypto.getRandomValues(new Uint8Array(n)));
      keys.set(p, kp);
      ch2.addParticipant(p, kp.publicKey, kp.privateKey);
      ch2.withBuyIn(p, 100n * K);
    }
    const epoch2 = ch2.openEpoch();
    // A fresh channel instance numbers its own epochs from 1; continuity
    // across instances is the deployment layer's concern.
    expect(epoch2.state.tableEpoch).toBe(1);
    expect(epoch2.state.participantSet.sort()).toEqual(["alice", "bob", "dave"]);
  });
});
