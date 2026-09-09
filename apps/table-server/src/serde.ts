/**
 * Bigint-safe serialization for engine states and actions (event payloads,
 * snapshots). Bigints become decimal strings; the parse side restores them.
 */

import type { PokerAction, TableState } from "@fiber-poker/poker-engine";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export function serializeBigints(value: unknown): Json {
  if (typeof value === "bigint") return value.toString();
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map(serializeBigints);
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(value)) out[k] = serializeBigints(v);
  return out;
}

function looksLikeBigintField(key: string): boolean {
  return (
    key === "stack" ||
    key === "streetContribution" ||
    key === "handContribution" ||
    key === "amount" ||
    key === "buyIn" ||
    key === "currentBet" ||
    key === "minimumRaise" ||
    key === "oddChips" ||
    key === "smallBlind" ||
    key === "bigBlind" ||
    key === "sequence"
  );
}

function revive(value: Json, key?: string): unknown {
  if (typeof value === "string" && key !== undefined && looksLikeBigintField(key) && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  if (Array.isArray(value)) return value.map((v) => revive(v));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = revive(v, k);
    return out;
  }
  return value;
}

export function serializeState(state: TableState): string {
  return JSON.stringify(serializeBigints(state));
}

export function parseState(json: string): TableState {
  return revive(JSON.parse(json)) as unknown as TableState;
}

export function serializeAction(action: PokerAction): Json {
  return serializeBigints(action);
}

export function parseAction(value: unknown): PokerAction {
  return revive(value as Json) as unknown as PokerAction;
}
