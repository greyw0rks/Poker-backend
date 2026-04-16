/**
 * handEvaluator.js
 *
 * Evaluates the best 5-card hand from 7 cards (2 hole + 5 board).
 * Returns a numeric score: higher = better hand.
 *
 * Hand categories (score ranges):
 *   Royal Flush      9_000_000+
 *   Straight Flush   8_000_000+
 *   Four of a Kind   7_000_000+
 *   Full House       6_000_000+
 *   Flush            5_000_000+
 *   Straight         4_000_000+
 *   Three of a Kind  3_000_000+
 *   Two Pair         2_000_000+
 *   One Pair         1_000_000+
 *   High Card        0+
 */

const { cardRank, cardSuit } = require('./deck');

const HAND_NAMES = [
  'High Card', 'One Pair', 'Two Pair', 'Three of a Kind',
  'Straight', 'Flush', 'Full House', 'Four of a Kind',
  'Straight Flush', 'Royal Flush',
];

/**
 * Generate all C(n, k) combinations.
 */
function combinations(arr, k) {
  const result = [];
  const combo = [];

  function pick(start) {
    if (combo.length === k) { result.push([...combo]); return; }
    for (let i = start; i <= arr.length - (k - combo.length); i++) {
      combo.push(arr[i]);
      pick(i + 1);
      combo.pop();
    }
  }

  pick(0);
  return result;
}

/**
 * Evaluate a 5-card hand. Returns { score, rank, name, cards }.
 */
function evaluate5(cards) {
  const ranks = cards.map(c => cardRank(c)).sort((a, b) => b - a); // desc
  const suits = cards.map(c => cardSuit(c));

  const isFlush = suits.every(s => s === suits[0]);

  // Straight check (also handles A-2-3-4-5 wheel)
  const isStraight = (() => {
    const uniq = [...new Set(ranks)];
    if (uniq.length !== 5) return false;
    if (uniq[0] - uniq[4] === 4) return true;
    // Wheel: A-2-3-4-5 → ranks would be [12,3,2,1,0]
    if (JSON.stringify(uniq) === JSON.stringify([12, 3, 2, 1, 0])) return true;
    return false;
  })();

  // Rank counts
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const countVals = Object.values(counts).sort((a, b) => b - a);

  // Tiebreaker: ordered ranks by (count desc, rank desc)
  const ranksByCount = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])
    .map(([r]) => Number(r));

  const tb = (ranksByCount[0] * 1e6 + ranksByCount[1] * 1e4 +
              ranksByCount[2] * 1e2 + (ranksByCount[3] || 0));

  // Straight top card (wheel top = 5, not Ace)
  const straightTop = (() => {
    if (!isStraight) return 0;
    if (ranks[0] === 12 && ranks[4] === 0) return 3; // wheel, top = 5 (rank 3)
    return ranks[0];
  })();

  let score, rank, name;

  if (isFlush && isStraight) {
    if (ranks[0] === 12 && ranks[1] === 11) {
      score = 9_000_000 + straightTop; rank = 9; name = 'Royal Flush';
    } else {
      score = 8_000_000 + straightTop; rank = 8; name = 'Straight Flush';
    }
  } else if (countVals[0] === 4) {
    score = 7_000_000 + tb; rank = 7; name = 'Four of a Kind';
  } else if (countVals[0] === 3 && countVals[1] === 2) {
    score = 6_000_000 + tb; rank = 6; name = 'Full House';
  } else if (isFlush) {
    score = 5_000_000 + tb; rank = 5; name = 'Flush';
  } else if (isStraight) {
    score = 4_000_000 + straightTop; rank = 4; name = 'Straight';
  } else if (countVals[0] === 3) {
    score = 3_000_000 + tb; rank = 3; name = 'Three of a Kind';
  } else if (countVals[0] === 2 && countVals[1] === 2) {
    score = 2_000_000 + tb; rank = 2; name = 'Two Pair';
  } else if (countVals[0] === 2) {
    score = 1_000_000 + tb; rank = 1; name = 'One Pair';
  } else {
    score = tb; rank = 0; name = 'High Card';
  }

  return { score, rank, name, cards };
}

/**
 * Find the best 5-card hand from an array of 7 cards.
 * Returns { score, rank, name, bestCards }
 */
function bestHand(sevenCards) {
  let best = null;
  for (const combo of combinations(sevenCards, 5)) {
    const result = evaluate5(combo);
    if (!best || result.score > best.score) {
      best = { ...result, bestCards: combo };
    }
  }
  return best;
}

/**
 * Rank all players' hands and return sorted results.
 *
 * @param {number[][]} holeCards  - Array of [c1, c2] per player
 * @param {number[]}   board      - 5 community cards
 * @param {number[]}   activePlayers - indices of players still in hand
 * @returns Array of { playerIndex, score, rank, name, bestCards } sorted best→worst
 */
function rankPlayers(holeCards, board, activePlayers) {
  const results = activePlayers.map(idx => {
    const seven = [...holeCards[idx], ...board];
    const hand = bestHand(seven);
    return { playerIndex: idx, ...hand };
  });

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Determine winners (handles ties).
 * Returns array of playerIndex values that share the top score.
 */
function determineWinners(holeCards, board, activePlayers) {
  const ranked = rankPlayers(holeCards, board, activePlayers);
  const topScore = ranked[0].score;
  return ranked.filter(r => r.score === topScore).map(r => r.playerIndex);
}

module.exports = {
  evaluate5, bestHand, rankPlayers, determineWinners,
  combinations, HAND_NAMES,
};
