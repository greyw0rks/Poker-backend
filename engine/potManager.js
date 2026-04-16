/**
 * potManager.js
 *
 * Handles the complexity of side pots in No-Limit Texas Hold'em.
 *
 * When a player goes all-in for less than the max bet, they can only win
 * up to their contribution from each player → main pot.
 * Excess contributions go into a side pot the all-in player can't win.
 *
 * Usage:
 *   const pm = new PotManager(playerCount);
 *   pm.addContribution(playerIdx, amount);   // call after each bet/call/raise
 *   const pots = pm.buildPots();             // call at showdown
 *   // pots = [{ amount, eligiblePlayers: [idx...] }, ...]
 */

class PotManager {
  constructor(playerCount) {
    this.playerCount = playerCount;
    // contributions[i] = total chips player i put in THIS street accumulation
    // We track cumulative per player across all streets
    this.contributions = new Array(playerCount).fill(0n);
    this.foldedPlayers = new Set();
  }

  /**
   * Record a player's total contribution to the pot.
   * Call with the new cumulative total (not the delta).
   */
  setContribution(playerIdx, totalAmount) {
    this.contributions[playerIdx] = BigInt(totalAmount);
  }

  /**
   * Add to a player's contribution (delta-based).
   */
  addContribution(playerIdx, amount) {
    this.contributions[playerIdx] += BigInt(amount);
  }

  markFolded(playerIdx) {
    this.foldedPlayers.add(playerIdx);
  }

  /**
   * Build the pot structure at showdown.
   *
   * Algorithm:
   *   1. Sort players by contribution ascending.
   *   2. For each "level" (defined by each all-in amount), create a pot:
   *      - Each player contributes min(theirContrib, level) to this pot.
   *      - Eligible winners = players who contributed >= level AND are active.
   *
   * Returns: [{ amount: bigint, eligiblePlayers: number[] }]
   */
  buildPots(activePlayers) {
    const active = new Set(activePlayers);
    const contribs = this.contributions.map((c, i) => ({ idx: i, amount: c }));

    // Unique contribution levels (sorted asc), excluding 0
    const levels = [...new Set(contribs.map(c => c.amount))]
      .filter(l => l > 0n)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const pots = [];
    let prevLevel = 0n;

    for (const level of levels) {
      const potAmount = contribs.reduce((sum, { amount }) => {
        const contrib = amount >= level ? level - prevLevel : amount - prevLevel;
        return sum + (contrib > 0n ? contrib : 0n);
      }, 0n);

      if (potAmount === 0n) continue;

      // Players eligible for this pot: contributed at least `level` AND active (not folded)
      const eligible = contribs
        .filter(({ idx, amount }) => amount >= level && active.has(idx))
        .map(({ idx }) => idx);

      pots.push({ amount: potAmount, eligiblePlayers: eligible });
      prevLevel = level;
    }

    return pots;
  }

  /**
   * Calculate final payouts given winners per pot.
   *
   * @param  activePlayers  Players who reached showdown
   * @param  rankFn         (eligiblePlayers) => winnerIndices[]  (tie-safe)
   * @returns { [playerIdx]: bigint }  gross payout per player (before house fee)
   */
  calculatePayouts(activePlayers, rankFn) {
    const pots = this.buildPots(activePlayers);
    const payouts = {};

    // Initialize payouts for all players
    for (let i = 0; i < this.playerCount; i++) {
      payouts[i] = 0n;
    }

    for (const pot of pots) {
      const winners = rankFn(pot.eligiblePlayers);

      // Split pot evenly (integer division, remainder goes to first winner)
      const share = pot.amount / BigInt(winners.length);
      const remainder = pot.amount % BigInt(winners.length);

      for (let i = 0; i < winners.length; i++) {
        payouts[winners[i]] += share + (i === 0 ? remainder : 0n);
      }
    }

    return payouts;
  }

  get totalPot() {
    return this.contributions.reduce((s, c) => s + c, 0n);
  }
}

module.exports = { PotManager };
