/**
 * gameEngine.js
 *
 * State machine for one hand of No-Limit Texas Hold'em.
 *
 * States: WAITING → PREFLOP → FLOP → TURN → RIVER → SHOWDOWN → FINISHED
 *
 * Public API:
 *   const game = new PokerGame(config);
 *   game.startHand();
 *   game.action(playerIdx, { type: 'fold'|'check'|'call'|'raise'|'allin', amount? });
 *   game.on('stateChange', handler);
 *   game.on('handComplete', handler);  // { payouts, winners, board }
 */

const EventEmitter = require('events');
const { dealHands, cardToString } = require('./deck');
const { determineWinners, rankPlayers } = require('./handEvaluator');
const { PotManager } = require('./potManager');

const STREETS   = ['PREFLOP', 'FLOP', 'TURN', 'RIVER'];
const TIMEOUTS  = { PREFLOP: 30, FLOP: 30, TURN: 30, RIVER: 30 }; // seconds

class PokerGame extends EventEmitter {
  /**
   * @param {object} config
   * @param {number}   config.tableId
   * @param {object[]} config.players   - [{ id, name, chips, isBot, address }]
   * @param {number}   config.smallBlind  - in chips (whole units matching buy-in)
   * @param {number}   config.bigBlind
   * @param {number}   config.dealerPos  - index of dealer button
   */
  constructor(config) {
    super();
    this.tableId    = config.tableId;
    this.players    = config.players.map((p, i) => ({
      ...p,
      index:   i,
      chips:   BigInt(p.chips),
      folded:  false,
      allIn:   false,
      sitting: true,
    }));
    this.smallBlind = BigInt(config.smallBlind || 50);
    this.bigBlind   = BigInt(config.bigBlind   || 100);
    this.dealerPos  = config.dealerPos || 0;
    this.handNumber = 0;

    this.state       = 'WAITING';
    this.board       = [];
    this.holeCards   = [];
    this.potManager  = null;
    this.streetBets  = [];    // current street bet per player
    this.currentBet  = 0n;   // highest bet this street
    this.lastRaise   = 0n;   // size of last raise (min-raise rule)
    this.actionIdx   = -1;   // whose turn it is
    this.actionTimer = null;

    this._dealData   = null;
  }

  // ─── Public ──────────────────────────────────────────────────────────────

  get activePlayers() {
    return this.players.filter(p => !p.folded && !p.eliminated && p.sitting);
  }

  get playersInHand() {
    return this.players.filter(p => !p.folded);
  }

  startHand() {
    if (this.state !== 'WAITING') throw new Error('Game already started');
    this._beginHand();
  }

  /**
   * Process a player action.
   * @param {number} playerIdx
   * @param {{ type: string, amount?: bigint }} action
   */
  action(playerIdx, action) {
    if (this.actionIdx !== playerIdx) {
      return { ok: false, error: 'Not your turn' };
    }

    const player = this.players[playerIdx];
    if (player.folded || player.allIn) {
      return { ok: false, error: 'Player not active' };
    }

    clearTimeout(this.actionTimer);

    try {
      this._applyAction(player, action);
    } catch (e) {
      return { ok: false, error: e.message };
    }

    this._afterAction();
    return { ok: true };
  }

  /**
   * Force-fold a player (timeout / disconnect).
   */
  forceAction(playerIdx) {
    this.action(playerIdx, { type: 'fold' });
  }

  getPublicState() {
    return {
      tableId:     this.tableId,
      state:       this.state,
      board:       this.board.map(cardToString),
      pot:         this.potManager?.totalPot.toString() ?? '0',
      currentBet:  this.currentBet.toString(),
      actionIdx:   this.actionIdx,
      players:     this.players.map(p => ({
        index:   p.index,
        name:    p.name,
        chips:   p.chips.toString(),
        bet:     (this.streetBets[p.index] ?? 0n).toString(),
        folded:  p.folded,
        allIn:   p.allIn,
        isBot:   p.isBot,
      })),
    };
  }

  getHoleCards(playerIdx) {
    return this.holeCards[playerIdx]?.map(cardToString) ?? [];
  }

  // ─── Private — Hand lifecycle ─────────────────────────────────────────────

  _beginHand() {
    this.handNumber++;
    this.board = [];

    // Reset player state
    for (const p of this.players) {
      p.folded = false;
      p.allIn  = false;
    }

    // Deal
    const numPlayers = this.players.length;
    this._dealData  = dealHands(numPlayers);
    this.holeCards  = this._dealData.hands;

    // Pot manager
    this.potManager = new PotManager(numPlayers);

    // Determine blind positions
    const sbIdx = (this.dealerPos + 1) % numPlayers;
    const bbIdx = (this.dealerPos + 2) % numPlayers;

    // Post blinds
    this.streetBets  = new Array(numPlayers).fill(0n);
    this.currentBet  = 0n;
    this.lastRaise   = this.bigBlind;

    this._postBlind(sbIdx, this.smallBlind);
    this._postBlind(bbIdx, this.bigBlind);

    this.state = 'PREFLOP';

    // First to act pre-flop: UTG (one after BB)
    const firstActor = (bbIdx + 1) % numPlayers;
    this.actionIdx = firstActor;

    this.emit('handStarted', {
      handNumber: this.handNumber,
      dealerPos:  this.dealerPos,
      sbIdx, bbIdx,
      holeCards:  this.holeCards.map((h, i) => ({
        playerIdx: i,
        cards: h.map(cardToString),
      })),
    });

    this._emitStateChange();
    this._startActionTimer();
  }

  _postBlind(playerIdx, amount) {
    const player  = this.players[playerIdx];
    const actual  = amount > player.chips ? player.chips : amount;
    player.chips -= actual;
    this.streetBets[playerIdx] = (this.streetBets[playerIdx] || 0n) + actual;
    this.potManager.addContribution(playerIdx, actual);
    if (actual < amount) player.allIn = true;
    if (actual > this.currentBet) {
      this.currentBet = actual;
    }
  }

  // ─── Private — Action handling ────────────────────────────────────────────

  _applyAction(player, { type, amount }) {
    const idx       = player.index;
    const toCall    = this.currentBet - (this.streetBets[idx] || 0n);
    const maxRaise  = player.chips;

    switch (type) {
      case 'fold':
        player.folded = true;
        this.potManager.markFolded(idx);
        this.emit('playerAction', { playerIdx: idx, type: 'fold' });
        break;

      case 'check':
        if (toCall > 0n) throw new Error('Cannot check — must call or fold');
        this.emit('playerAction', { playerIdx: idx, type: 'check' });
        break;

      case 'call': {
        const callAmt = toCall >= player.chips ? player.chips : toCall;
        player.chips -= callAmt;
        this.streetBets[idx] = (this.streetBets[idx] || 0n) + callAmt;
        this.potManager.addContribution(idx, callAmt);
        if (player.chips === 0n) player.allIn = true;
        this.emit('playerAction', { playerIdx: idx, type: 'call', amount: callAmt.toString() });
        break;
      }

      case 'raise':
      case 'bet': {
        const raiseAmt = BigInt(amount);
        // Min raise = lastRaise (or BB pre-flop)
        const totalBet = (this.streetBets[idx] || 0n) + raiseAmt;
        const raiseSize = totalBet - this.currentBet;
        if (raiseSize < this.lastRaise && raiseAmt < player.chips) {
          throw new Error(`Min raise is ${this.lastRaise}`);
        }
        const actual = raiseAmt > player.chips ? player.chips : raiseAmt;
        player.chips -= actual;
        this.streetBets[idx] = (this.streetBets[idx] || 0n) + actual;
        this.potManager.addContribution(idx, actual);
        const newTotalBet = this.streetBets[idx];
        if (newTotalBet > this.currentBet) {
          this.lastRaise  = newTotalBet - this.currentBet;
          this.currentBet = newTotalBet;
        }
        if (player.chips === 0n) player.allIn = true;
        this.emit('playerAction', { playerIdx: idx, type, amount: actual.toString() });
        break;
      }

      case 'allin': {
        const allInAmt = player.chips;
        player.chips = 0n;
        this.streetBets[idx] = (this.streetBets[idx] || 0n) + allInAmt;
        this.potManager.addContribution(idx, allInAmt);
        const newTotalBet = this.streetBets[idx];
        if (newTotalBet > this.currentBet) {
          this.lastRaise  = newTotalBet - this.currentBet;
          this.currentBet = newTotalBet;
        }
        player.allIn = true;
        this.emit('playerAction', { playerIdx: idx, type: 'allin', amount: allInAmt.toString() });
        break;
      }

      default:
        throw new Error(`Unknown action: ${type}`);
    }
  }

  _afterAction() {
    // Check if hand is over (all but one folded)
    const live = this.players.filter(p => !p.folded);
    if (live.length === 1) {
      this._awardUncontested(live[0]);
      return;
    }

    // Check if betting round is complete
    if (this._bettingComplete()) {
      this._advanceStreet();
    } else {
      this._nextActor();
      this._emitStateChange();
      this._startActionTimer();
    }
  }

  _bettingComplete() {
    // All active (non-folded, non-allIn) players have matched currentBet
    // AND at least one full orbit has completed since last raise
    for (const p of this.players) {
      if (p.folded || p.allIn) continue;
      if ((this.streetBets[p.index] || 0n) < this.currentBet) return false;
    }
    return true;
  }

  _nextActor() {
    const n = this.players.length;
    let idx = (this.actionIdx + 1) % n;
    let loops = 0;
    while (loops < n) {
      const p = this.players[idx];
      if (!p.folded && !p.allIn) {
        this.actionIdx = idx;
        return;
      }
      idx = (idx + 1) % n;
      loops++;
    }
    // All remaining are all-in → advance street
    this._advanceStreet();
  }

  _advanceStreet() {
    const currentIdx = STREETS.indexOf(this.state);
    if (currentIdx === -1 || currentIdx === STREETS.length - 1) {
      this._showdown();
      return;
    }

    this.state = STREETS[currentIdx + 1];

    // Reset street bets
    this.streetBets = new Array(this.players.length).fill(0n);
    this.currentBet = 0n;
    this.lastRaise  = this.bigBlind;

    // Reveal community cards
    switch (this.state) {
      case 'FLOP':
        this.board = [...this._dealData.flop];
        break;
      case 'TURN':
        this.board = [...this._dealData.flop, this._dealData.turn];
        break;
      case 'RIVER':
        this.board = [...this._dealData.flop, this._dealData.turn, this._dealData.river];
        break;
    }

    this.emit('streetDealt', {
      street: this.state,
      board:  this.board.map(cardToString),
    });

    // First to act post-flop: first active player left of dealer
    this._setFirstPostFlopActor();
    this._emitStateChange();
    this._startActionTimer();
  }

  _setFirstPostFlopActor() {
    const n = this.players.length;
    let idx = (this.dealerPos + 1) % n;
    for (let i = 0; i < n; i++) {
      const p = this.players[idx];
      if (!p.folded && !p.allIn) {
        this.actionIdx = idx;
        return;
      }
      idx = (idx + 1) % n;
    }
    // All-in run-out → go straight to showdown
    this.actionIdx = -1;
    this._advanceStreet();
  }

  _showdown() {
    this.state = 'SHOWDOWN';
    const activeIdxs = this.players
      .filter(p => !p.folded)
      .map(p => p.index);

    // Rank players
    const ranked = rankPlayers(this.holeCards, this.board, activeIdxs);

    // Determine payouts using pot manager
    const payouts = this.potManager.calculatePayouts(activeIdxs, (eligible) => {
      return determineWinners(this.holeCards, this.board, eligible);
    });

    // Credit chips back
    for (const [idxStr, amount] of Object.entries(payouts)) {
      this.players[Number(idxStr)].chips += amount;
    }

    // Build final result
    const result = {
      handNumber: this.handNumber,
      board:      this.board.map(cardToString),
      payouts:    Object.fromEntries(
        Object.entries(payouts).map(([i, v]) => [i, v.toString()])
      ),
      winners: Object.entries(payouts)
        .filter(([, v]) => v > 0n)
        .map(([i]) => Number(i)),
      ranked: ranked.map(r => ({
        playerIdx: r.playerIndex,
        handName:  r.name,
        score:     r.score,
        cards:     this.holeCards[r.playerIndex].map(cardToString),
      })),
    };

    this.state = 'FINISHED';
    this.emit('handComplete', result);
    this._emitStateChange();

    // Rotate dealer
    this.dealerPos = (this.dealerPos + 1) % this.players.length;
  }

  _awardUncontested(winner) {
    const pot = this.potManager.totalPot;
    winner.chips += pot;
    this.state = 'FINISHED';

    const result = {
      handNumber: this.handNumber,
      board:      this.board.map(cardToString),
      payouts:    { [winner.index]: pot.toString() },
      winners:    [winner.index],
      uncontested: true,
    };

    this.emit('handComplete', result);
    this._emitStateChange();
    this.dealerPos = (this.dealerPos + 1) % this.players.length;
  }

  _startActionTimer() {
    if (this.actionIdx < 0) return;
    clearTimeout(this.actionTimer);
    this.actionTimer = setTimeout(() => {
      this.emit('actionTimeout', { playerIdx: this.actionIdx });
      this.forceAction(this.actionIdx);
    }, (TIMEOUTS[this.state] || 30) * 1000);
  }

  _emitStateChange() {
    this.emit('stateChange', this.getPublicState());
  }
}

module.exports = { PokerGame, STREETS };
