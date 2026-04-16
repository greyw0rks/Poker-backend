/**
 * deck.js — Standard 52-card deck with Fisher-Yates shuffle.
 *
 * Card encoding: integer 0-51
 *   rank = card % 13     (0=2, 1=3, ..., 8=T, 9=J, 10=Q, 11=K, 12=A)
 *   suit = card >> 2     (0=♠, 1=♥, 2=♦, 3=♣)  -- wait, we want 4 suits
 *   suit = Math.floor(card / 13)  (0=♠, 1=♥, 2=♦, 3=♣)
 *   rank = card % 13
 */

const SUIT_NAMES = ['♠', '♥', '♦', '♣'];
const RANK_NAMES = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];

const SUIT_CHARS = ['s','h','d','c'];

function cardSuit(card) { return Math.floor(card / 13); }
function cardRank(card) { return card % 13; }

/**
 * Human-readable card string e.g. "As", "Td", "2h"
 */
function cardToString(card) {
  return RANK_NAMES[cardRank(card)] + SUIT_CHARS[cardSuit(card)];
}

function cardToDisplay(card) {
  return RANK_NAMES[cardRank(card)] + SUIT_NAMES[cardSuit(card)];
}

/**
 * Parse "As" → card integer
 */
function parseCard(str) {
  const rank = RANK_NAMES.indexOf(str[0].toUpperCase());
  const suit = SUIT_CHARS.indexOf(str[1].toLowerCase());
  if (rank === -1 || suit === -1) throw new Error(`Invalid card: ${str}`);
  return suit * 13 + rank;
}

/**
 * Create a fresh ordered deck [0..51]
 */
function newDeck() {
  return Array.from({ length: 52 }, (_, i) => i);
}

/**
 * Fisher-Yates in-place shuffle
 */
function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/**
 * DealResult from a fresh shuffled deck:
 *   { hands: [[c1,c2], ...], board: [c1..c5], deck: remaining }
 */
function dealHands(numPlayers) {
  if (numPlayers < 2 || numPlayers > 9) throw new Error('Invalid player count');
  const deck = shuffle(newDeck());
  const hands = [];
  let idx = 0;

  // Deal 2 hole cards per player
  for (let p = 0; p < numPlayers; p++) {
    hands.push([deck[idx++], deck[idx++]]);
  }

  // Burn + flop
  idx++; // burn
  const flop = [deck[idx++], deck[idx++], deck[idx++]];

  // Burn + turn
  idx++;
  const turn = deck[idx++];

  // Burn + river
  idx++;
  const river = deck[idx++];

  return {
    hands,
    flop,
    turn,
    river,
    board: [...flop, turn, river],
    remaining: deck.slice(idx),
  };
}

module.exports = {
  cardSuit, cardRank, cardToString, cardToDisplay, parseCard,
  newDeck, shuffle, dealHands,
  SUIT_NAMES, RANK_NAMES, SUIT_CHARS,
};
