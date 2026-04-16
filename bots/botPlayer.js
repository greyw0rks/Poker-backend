/**
 * botPlayer.js
 *
 * Bot AI with 5 configurable strategies, designed to stress-test every
 * code path in the game engine:
 *
 *   RANDOM       — Does anything randomly (hits edge cases)
 *   CALL_STATION — Calls everything (tests pot math & payout)
 *   FOLDER       — Folds immediately (tests early termination)
 *   AGGRESSIVE   — Raises / shoves constantly (tests all-in & side pots)
 *   GTO_BASIC    — Simple GTO-like logic using hand strength (most realistic)
 *
 * Each bot acts with a configurable delay to simulate human think time.
 */

const { bestHand } = require('../engine/handEvaluator');
const { cardToString, parseCard } = require('../engine/deck');

const STRATEGIES = {
  RANDOM:       'RANDOM',
  CALL_STATION: 'CALL_STATION',
  FOLDER:       'FOLDER',
  AGGRESSIVE:   'AGGRESSIVE',
  GTO_BASIC:    'GTO_BASIC',
};

// Min/max think delay in ms
const THINK_DELAY = { min: 400, max: 2200 };

class BotPlayer {
  /**
   * @param {object} config
   * @param {number} config.playerIdx
   * @param {string} config.strategy  — one of STRATEGIES keys
   * @param {number} config.thinkMin  — ms (default 400)
   * @param {number} config.thinkMax  — ms (default 2200)
   */
  constructor(config) {
    this.playerIdx = config.playerIdx;
    this.strategy  = config.strategy || STRATEGIES.GTO_BASIC;
    this.thinkMin  = config.thinkMin ?? THINK_DELAY.min;
    this.thinkMax  = config.thinkMax ?? THINK_DELAY.max;
    this.name      = config.name || `Bot_${config.strategy?.slice(0,3)}_${config.playerIdx}`;
  }

  // ─── Public ───────────────────────────────────────────────────────────────

  /**
   * Decide an action given the current game state.
   * Returns a Promise that resolves after "think" delay.
   *
   * @param {object} gameState    Public game state from getPublicState()
   * @param {number[]} holeCards  This bot's hole cards
   * @returns Promise<{ type, amount? }>
   */
  async decide(gameState, holeCards) {
    await this._thinkDelay();

    const context = this._buildContext(gameState, holeCards);

    switch (this.strategy) {
      case STRATEGIES.RANDOM:       return this._strategyRandom(context);
      case STRATEGIES.CALL_STATION: return this._strategyCallStation(context);
      case STRATEGIES.FOLDER:       return this._strategyFolder(context);
      case STRATEGIES.AGGRESSIVE:   return this._strategyAggressive(context);
      case STRATEGIES.GTO_BASIC:    return this._strategyGTO(context);
      default:                      return this._strategyCallStation(context);
    }
  }

  // ─── Strategies ───────────────────────────────────────────────────────────

  _strategyRandom({ canCheck, toCall, myChips, currentBet }) {
    const r = Math.random();
    if (r < 0.25) return { type: 'fold' };
    if (canCheck && r < 0.5) return { type: 'check' };
    if (r < 0.6) return toCall > 0n ? { type: 'call' } : { type: 'check' };
    if (r < 0.85) {
      const raiseAmt = toCall + (myChips / 4n);
      return { type: 'raise', amount: raiseAmt };
    }
    return { type: 'allin' };
  }

  _strategyCallStation({ canCheck, toCall }) {
    if (canCheck) return { type: 'check' };
    return { type: 'call' };
  }

  _strategyFolder() {
    return { type: 'fold' };
  }

  _strategyAggressive({ canCheck, toCall, myChips, potSize, currentBet }) {
    // 70% raise/shove, 20% call, 10% fold
    const r = Math.random();
    if (r < 0.10 && toCall > 0n) return { type: 'fold' };
    if (r < 0.30) return toCall > 0n ? { type: 'call' } : { type: 'check' };
    if (r < 0.65) {
      // Pot-sized raise
      const raiseAmt = (potSize + toCall) * 2n + toCall;
      return { type: 'raise', amount: raiseAmt > myChips ? myChips : raiseAmt };
    }
    return { type: 'allin' };
  }

  _strategyGTO({ canCheck, toCall, myChips, potSize, board, holeCards, streetName }) {
    if (!holeCards || holeCards.length < 2) return { type: 'fold' };

    const strength = this._handStrength(holeCards, board);

    // Pre-flop: use hole card strength
    if (streetName === 'PREFLOP') {
      return this._preFlopDecision(strength, toCall, myChips, potSize, canCheck);
    }

    // Post-flop: use made-hand strength
    return this._postFlopDecision(strength, toCall, myChips, potSize, canCheck);
  }

  _preFlopDecision(strength, toCall, myChips, potSize, canCheck) {
    // strength: 0–1 based on hole card rank
    if (strength > 0.85) {
      // Premium: AA, KK, AK etc — 3-bet/shove
      const raiseAmt = potSize * 3n + toCall;
      return { type: 'raise', amount: raiseAmt > myChips ? myChips : raiseAmt };
    }
    if (strength > 0.65) {
      // Good hands: call or small raise
      if (Math.random() > 0.5) {
        const raiseAmt = toCall + potSize;
        return { type: 'raise', amount: raiseAmt > myChips ? myChips : raiseAmt };
      }
      return toCall > 0n ? { type: 'call' } : { type: 'check' };
    }
    if (strength > 0.40) {
      // Speculative: call only if cheap
      if (toCall === 0n || toCall < myChips / 10n) {
        return toCall > 0n ? { type: 'call' } : { type: 'check' };
      }
      return { type: 'fold' };
    }
    // Weak: fold to any bet, check if free
    if (canCheck) return { type: 'check' };
    return { type: 'fold' };
  }

  _postFlopDecision(strength, toCall, myChips, potSize, canCheck) {
    if (strength > 0.80) {
      // Strong made hand: value bet / raise
      if (Math.random() > 0.3) {
        const betAmt = (potSize * 2n) / 3n + toCall;
        return { type: 'raise', amount: betAmt > myChips ? myChips : betAmt };
      }
      return toCall > 0n ? { type: 'call' } : { type: 'check' };
    }
    if (strength > 0.55) {
      // Medium: call or small bet
      if (canCheck) return { type: 'check' };
      if (toCall < myChips / 5n) return { type: 'call' };
      return { type: 'fold' };
    }
    if (strength > 0.35) {
      // Marginal: check-call small, fold to pressure
      if (canCheck) return { type: 'check' };
      if (toCall < myChips / 8n) return { type: 'call' };
      return { type: 'fold' };
    }
    // Weak: give up
    if (canCheck) return { type: 'check' };
    return { type: 'fold' };
  }

  // ─── Hand Strength ────────────────────────────────────────────────────────

  /**
   * Estimate hand strength 0–1.
   * Pre-flop: uses hole card rank heuristic.
   * Post-flop: uses actual hand evaluator score.
   */
  _handStrength(holeCards, board) {
    if (!board || board.length === 0) {
      return this._preFlopStrength(holeCards);
    }
    return this._madeHandStrength(holeCards, board);
  }

  _preFlopStrength(holeCards) {
    // Simple rank-based heuristic (0–1)
    const [r1, r2] = holeCards.map(c => c % 13);
    const maxRank   = Math.max(r1, r2); // 0-12 (A=12)
    const minRank   = Math.min(r1, r2);
    const suited    = Math.floor(holeCards[0] / 13) === Math.floor(holeCards[1] / 13);
    const pair      = r1 === r2;
    const gap       = maxRank - minRank;

    let score = (maxRank + minRank) / 24; // 0–1 base

    if (pair) score += 0.20 + (maxRank / 12) * 0.15;
    if (suited) score += 0.08;
    if (gap <= 1) score += 0.05;  // connector
    if (gap <= 3) score += 0.03;  // 1-gap

    return Math.min(1, score);
  }

  _madeHandStrength(holeCards, board) {
    const seven = [...holeCards, ...board];
    try {
      const { score } = bestHand(seven);
      // Normalize: max possible score ≈ 9_012_000 (royal flush tiebreaker)
      return Math.min(1, score / 9_012_000);
    } catch {
      return 0.3;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _buildContext(gameState, holeCards) {
    const me        = gameState.players[this.playerIdx];
    const myChips   = BigInt(me?.chips ?? '0');
    const myBet     = BigInt(me?.bet   ?? '0');
    const curBet    = BigInt(gameState.currentBet);
    const toCall    = curBet - myBet < 0n ? 0n : curBet - myBet;
    const potSize   = BigInt(gameState.pot);
    const canCheck  = toCall === 0n;

    return {
      myChips,
      myBet,
      toCall,
      potSize,
      canCheck,
      currentBet: curBet,
      board:      gameState.board,   // string[] like ["As","Kd","Jh"]
      holeCards,                      // raw card integers
      streetName: gameState.state,
    };
  }

  _thinkDelay() {
    const ms = this.thinkMin + Math.random() * (this.thinkMax - this.thinkMin);
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Factory: create a set of bots with varied strategies for a test table.
 * Guaranteed to hit every major code path.
 */
function createTestBots(count = 5, options = {}) {
  const strategies = [
    STRATEGIES.GTO_BASIC,
    STRATEGIES.AGGRESSIVE,
    STRATEGIES.CALL_STATION,
    STRATEGIES.RANDOM,
    STRATEGIES.FOLDER,
    STRATEGIES.GTO_BASIC,
  ].slice(0, count);

  return strategies.map((strategy, i) => new BotPlayer({
    playerIdx: i,
    strategy,
    name: `Bot_${strategy.slice(0, 4)}_${i + 1}`,
    thinkMin: options.fast ? 50  : THINK_DELAY.min,
    thinkMax: options.fast ? 200 : THINK_DELAY.max,
  }));
}

module.exports = { BotPlayer, createTestBots, STRATEGIES };
