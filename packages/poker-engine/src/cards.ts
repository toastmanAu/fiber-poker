/**
 * Card representation: a card is an integer 0..51.
 *   card = rank * 4 + suit
 *   rank: 0..12 maps to 2,3,4,5,6,7,8,9,T,J,Q,K,A
 *   suit: 0..3 maps to c, d, h, s
 *
 * Integer cards keep the engine deterministic and cheap to hash/sign.
 * Strings ("As", "Td") exist only at the UI / wire boundary.
 */

export const RANK_CHARS = "23456789TJQKA" as const;
export const SUIT_CHARS = "cdhs" as const;

export type Card = number;

export function cardOf(rank: number, suit: number): Card {
  if (rank < 0 || rank > 12 || suit < 0 || suit > 3) {
    throw new Error(`invalid card coordinates rank=${rank} suit=${suit}`);
  }
  return rank * 4 + suit;
}

export function cardRank(card: Card): number {
  return Math.floor(card / 4);
}

export function cardSuit(card: Card): number {
  return card % 4;
}

export function cardToString(card: Card): string {
  return `${RANK_CHARS[cardRank(card)]}${SUIT_CHARS[cardSuit(card)]}`;
}

export function cardFromString(s: string): Card {
  if (s.length !== 2) throw new Error(`invalid card string: ${s}`);
  const rank = RANK_CHARS.indexOf(s[0]!);
  const suit = SUIT_CHARS.indexOf(s[1]!);
  if (rank < 0 || suit < 0) throw new Error(`invalid card string: ${s}`);
  return cardOf(rank, suit);
}

export function cardsToStrings(cards: readonly Card[]): string[] {
  return cards.map(cardToString);
}

export function cardsFromStrings(ss: readonly string[]): Card[] {
  return ss.map(cardFromString);
}

/** The full 52-card deck in canonical order (2c, 2d, ... As). */
export function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (let rank = 0; rank < 13; rank++) {
    for (let suit = 0; suit < 4; suit++) {
      deck.push(cardOf(rank, suit));
    }
  }
  return deck;
}

export const DECK_SIZE = 52;
