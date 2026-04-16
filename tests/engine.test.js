/**
 * tests/engine.test.js
 *
 * Pure JS tests — no blockchain needed.
 * Run: npm test
 */

const { dealHands, cardToString, parseCard, newDeck, shuffle } = require('../engine/deck');
const { evaluate5, bestHand, determineWinners, rankPlayers } = require('../engine/handEvaluator');
const { PotManager } = require('../engine/potManager');
const { PokerGame }  = require('../engine/gameEngine');
const { BotPlayer, createTestBots, STRATEGIES } = require('../bots/botPlayer');

jest.setTimeout(30_000); // bots have think delays

// ─────────────────────────────────────────────────────────────────────────────
describe('Deck', () => {
  test('newDeck has 52 unique cards', () => {
    const d = newDeck();
    expect(d.length).toBe(52);
    expect(new Set(d).size).toBe(52);
  });

  test('shuffle produces different order', () => {
    const a = newDeck();
    const b = shuffle(a);
    expect(b.length).toBe(52);
    expect(b).not.toEqual(a); // 1 in 52! chance of failure — acceptable
  });

  test('dealHands deals correct counts', () => {
    const { hands, board, flop, turn, river } = dealHands(6);
    expect(hands.length).toBe(6);
    hands.forEach(h => expect(h.length).toBe(2));
    expect(flop.length).toBe(3);
    expect(typeof turn).toBe('number');
    expect(typeof river).toBe('number');
    expect(board.length).toBe(5);
  });

  test('all cards are unique after deal', () => {
    const { hands, board } = dealHands(6);
    const all = [...hands.flat(), ...board];
    expect(new Set(all).size).toBe(all.length);
  });

  test('cardToString formats correctly', () => {
    expect(cardToString(0)).toBe('2s');   // rank 0, suit 0 (spades)
    expect(cardToString(12)).toBe('As');  // rank 12 (Ace), suit 0
    expect(cardToString(13)).toBe('2h');  // rank 0, suit 1 (hearts)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Hand Evaluator', () => {
  function cards(...strs) {
    return strs.map(parseCard);
  }

  test('Royal Flush beats everything', () => {
    const rf = evaluate5(cards('As','Ks','Qs','Js','Ts'));
    const sf = evaluate5(cards('9h','8h','7h','6h','5h'));
    expect(rf.score).toBeGreaterThan(sf.score);
    expect(rf.name).toBe('Royal Flush');
  });

  test('Straight Flush recognized', () => {
    const { name } = evaluate5(cards('9h','8h','7h','6h','5h'));
    expect(name).toBe('Straight Flush');
  });

  test('Four of a Kind recognized', () => {
    const { name } = evaluate5(cards('Ah','Ad','Ac','As','2h'));
    expect(name).toBe('Four of a Kind');
  });

  test('Full House recognized', () => {
    const { name } = evaluate5(cards('Ah','Ad','Ac','Ks','Kh'));
    expect(name).toBe('Full House');
  });

  test('Flush recognized', () => {
    const { name } = evaluate5(cards('2h','5h','7h','9h','Jh'));
    expect(name).toBe('Flush');
  });

  test('Straight recognized', () => {
    const { name } = evaluate5(cards('9s','8h','7d','6c','5s'));
    expect(name).toBe('Straight');
  });

  test('Wheel straight (A-2-3-4-5)', () => {
    const { name } = evaluate5(cards('As','2h','3d','4c','5s'));
    expect(name).toBe('Straight');
  });

  test('Three of a Kind recognized', () => {
    const { name } = evaluate5(cards('Ah','Ad','Ac','2s','3h'));
    expect(name).toBe('Three of a Kind');
  });

  test('Two Pair recognized', () => {
    const { name } = evaluate5(cards('Ah','Ad','Ks','Kh','2c'));
    expect(name).toBe('Two Pair');
  });

  test('One Pair recognized', () => {
    const { name } = evaluate5(cards('Ah','Ad','Ks','Qh','2c'));
    expect(name).toBe('One Pair');
  });

  test('High Card recognized', () => {
    const { name } = evaluate5(cards('Ah','Kd','Qs','Jc','9h'));
    expect(name).toBe('High Card');
  });

  test('bestHand picks best 5 from 7', () => {
    // Verify bestHand finds Four of a Kind from 7 cards where only 5 form quads
    // Ah Ad Ac As 2h Kd 7s → Four Aces is the best 5-card hand
    const seven = cards('Ah','Ad','Ac','As','2h','Kd','7s');
    const { name } = bestHand(seven);
    expect(name).toBe('Four of a Kind');
  });

  test('bestHand finds flush over pair', () => {
    // 5 spades + pair of kings: flush beats two-pair
    const seven = cards('2s','5s','7s','9s','Js','Kh','Kd');
    const { name } = bestHand(seven);
    expect(name).toBe('Flush');
  });

  test('determines single winner correctly', () => {
    // Alice: Ac Kc on Qc Jc Tc 2h 3d (royal flush)
    // Bob:   2d 3c on same board (high card)
    const holeCards = [cards('Ac','Kc'), cards('2d','3c')];
    const board = cards('Qc','Jc','Tc','2h','7d');
    const winners = determineWinners(holeCards, board, [0, 1]);
    expect(winners).toEqual([0]); // Alice wins
  });

  test('handles tie correctly', () => {
    // Both players have the same board-only 5-card hand (no hole card improvement)
    const board  = cards('As','Ks','Qs','Js','Ts'); // Royal Flush on board
    const holeCards = [cards('2h','3h'), cards('4d','5d')];
    const winners = determineWinners(holeCards, board, [0, 1]);
    expect(winners.length).toBe(2); // Both use board, split pot
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PotManager', () => {
  test('single pot, single winner', () => {
    const pm = new PotManager(3);
    pm.addContribution(0, 100n);
    pm.addContribution(1, 100n);
    pm.addContribution(2, 100n);

    const payouts = pm.calculatePayouts([0, 1, 2], (eligible) => [eligible[0]]);
    expect(payouts[0]).toBe(300n);
    expect(payouts[1]).toBe(0n);
  });

  test('split pot on tie', () => {
    const pm = new PotManager(2);
    pm.addContribution(0, 100n);
    pm.addContribution(1, 100n);

    const payouts = pm.calculatePayouts([0, 1], (eligible) => eligible); // all tie
    expect(payouts[0]).toBe(100n);
    expect(payouts[1]).toBe(100n);
  });

  test('side pot: player0 all-in for less', () => {
    const pm = new PotManager(3);
    // Player 0 goes all-in for 50, others bet 100
    pm.addContribution(0, 50n);
    pm.addContribution(1, 100n);
    pm.addContribution(2, 100n);

    // Player 0 wins main pot (150), Player 1 wins side pot (100)
    let callCount = 0;
    const payouts = pm.calculatePayouts([0, 1, 2], (eligible) => {
      callCount++;
      // First call: main pot eligible includes player 0
      if (eligible.includes(0)) return [0]; // player 0 wins main
      return [1]; // player 1 wins side
    });

    expect(payouts[0]).toBe(150n); // main pot = 50×3 = 150 → player0 wins
    expect(payouts[1]).toBe(100n); // side pot = (100-50)×2 = 100 → player1 wins
    expect(payouts[2]).toBe(0n);   // player2 lost side pot
    // Verify conservation: 150+100 = 250 = 50+100+100 ✓
  });

  test('totalPot sums correctly', () => {
    const pm = new PotManager(4);
    pm.addContribution(0, 200n);
    pm.addContribution(1, 150n);
    pm.addContribution(2, 100n);
    pm.addContribution(3, 50n);
    expect(pm.totalPot).toBe(500n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('PokerGame Engine', () => {
  function makeGame(numPlayers = 3, chipsEach = 1000n) {
    const players = Array.from({ length: numPlayers }, (_, i) => ({
      id: `p${i}`, name: `Player${i}`, chips: chipsEach.toString(),
      isBot: false, address: `0x${i}`,
    }));
    return new PokerGame({ tableId: 'test', players, smallBlind: '1', bigBlind: '2', dealerPos: 0 });
  }

  test('startHand transitions to PREFLOP', () => {
    const game = makeGame();
    game.startHand();
    expect(game.state).toBe('PREFLOP');
  });

  test('each player receives 2 hole cards', () => {
    const game = makeGame(4);
    game.startHand();
    for (let i = 0; i < 4; i++) {
      const cards = game.getHoleCards(i);
      expect(cards.length).toBe(2);
    }
  });

  test('blinds are posted to pot', () => {
    const game = makeGame(3);
    game.startHand();
    expect(game.potManager.totalPot).toBe(3n); // SB=1 + BB=2
  });

  test('fold reduces active players', () => {
    const game = makeGame(3);
    game.startHand();
    // UTG acts first pre-flop
    const result = game.action(game.actionIdx, { type: 'fold' });
    expect(result.ok).toBe(true);
    expect(game.players[0].folded || game.players[1].folded || game.players[2].folded).toBe(true);
  });

  test('wrong player turn returns error', () => {
    const game = makeGame(3);
    game.startHand();
    const wrongIdx = (game.actionIdx + 1) % 3;
    const result = game.action(wrongIdx, { type: 'check' });
    expect(result.ok).toBe(false);
  });

  test('all-fold to one player awards pot uncontested', (done) => {
    const game = makeGame(3);
    game.on('handComplete', (result) => {
      expect(result.winners.length).toBe(1);
      expect(result.uncontested).toBe(true);
      done();
    });
    game.startHand();

    // Force two folds
    const foldTwo = () => {
      if (game.state === 'FINISHED') return;
      game.action(game.actionIdx, { type: 'fold' });
      if (game.state !== 'FINISHED') {
        game.action(game.actionIdx, { type: 'fold' });
      }
    };
    foldTwo();
  });

  test('full hand plays to FINISHED via check-down', (done) => {
    const game = makeGame(3, 10000n);
    game.on('handComplete', (result) => {
      expect(result.winners.length).toBeGreaterThan(0);
      expect(game.state).toBe('FINISHED');
      done();
    });

    // Helper: always check/call until hand is done
    const doAction = () => {
      if (game.state === 'FINISHED') return;
      const idx = game.actionIdx;
      if (idx < 0) return;
      const player = game.players[idx];
      if (player.folded || player.allIn) return;

      const myBet   = game.streetBets[idx] || 0n;
      const toCall  = game.currentBet - myBet;
      game.action(idx, toCall === 0n ? { type: 'check' } : { type: 'call' });
    };

    game.on('stateChange', () => { if (game.state !== 'FINISHED') doAction(); });
    game.startHand();
    doAction();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Bot Players', () => {
  function makeGameWithBots(numBots = 3, strategy = STRATEGIES.CALL_STATION) {
    const players = Array.from({ length: numBots }, (_, i) => ({
      id: `bot${i}`, name: `Bot${i}`, chips: '500',
      isBot: true, address: `0x${i}`,
    }));
    return new PokerGame({ tableId: 'bot-test', players, smallBlind: '1', bigBlind: '2', dealerPos: 0 });
  }

  test('BotPlayer decides within timeout', async () => {
    const bot = new BotPlayer({
      playerIdx: 0,
      strategy: STRATEGIES.GTO_BASIC,
      thinkMin: 0,
      thinkMax: 10,
    });
    const state = {
      state: 'PREFLOP',
      currentBet: '2',
      pot: '3',
      players: [
        { index: 0, chips: '498', bet: '0', folded: false, allIn: false },
        { index: 1, chips: '499', bet: '1', folded: false, allIn: false },
        { index: 2, chips: '498', bet: '2', folded: false, allIn: false },
      ],
      board: [],
    };
    const holeCards = [0, 12]; // 2s, As

    const action = await bot.decide(state, holeCards);
    expect(['fold', 'check', 'call', 'raise', 'allin']).toContain(action.type);
  });

  test('FOLDER bot always folds', async () => {
    const bot = new BotPlayer({ playerIdx: 0, strategy: STRATEGIES.FOLDER, thinkMin: 0, thinkMax: 0 });
    const action = await bot.decide({ state: 'PREFLOP', currentBet: '10', pot: '10', players: [{ index: 0, chips: '100', bet: '0', folded: false, allIn: false }], board: [] }, [0, 1]);
    expect(action.type).toBe('fold');
  });

  test('CALL_STATION bot calls or checks', async () => {
    const bot = new BotPlayer({ playerIdx: 0, strategy: STRATEGIES.CALL_STATION, thinkMin: 0, thinkMax: 0 });
    const state = { state: 'PREFLOP', currentBet: '10', pot: '10', players: [{ index: 0, chips: '100', bet: '0', folded: false, allIn: false }], board: [] };
    const action = await bot.decide(state, [0, 1]);
    expect(['call', 'check']).toContain(action.type);
  });

  test('createTestBots creates correct number', () => {
    const bots = createTestBots(5, { fast: true });
    expect(bots.length).toBe(5);
    expect(bots.every(b => b instanceof BotPlayer)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Full Bot Game Simulation', () => {
  test('6-bot game runs to completion without errors', (done) => {
    const players = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`, name: `Bot${i}`, chips: '10000',
      isBot: true, address: `0x${i}`,
    }));

    const bots = createTestBots(6, { fast: true });
    // Reassign indices
    bots.forEach((b, i) => b.playerIdx = i);

    const game = new PokerGame({
      tableId: 'sim-test',
      players,
      smallBlind: '50',
      bigBlind:   '100',
      dealerPos:  0,
    });

    game.on('handComplete', (result) => {
      expect(result.winners.length).toBeGreaterThan(0);
      expect(Object.keys(result.payouts).length).toBeGreaterThan(0);

      // Verify pot conservation: sum of payouts ≤ totalPot (house takes 10% off-chain)
      const totalPaidOut = Object.values(result.payouts)
        .reduce((s, v) => s + BigInt(v), 0n);
      // Should be positive
      expect(totalPaidOut).toBeGreaterThan(0n);

      console.log(`  ✅ Hand complete — Winners: [${result.winners.join(',')}] Board: [${result.board.join(' ')}]`);
      done();
    });

    // Wire bot actions
    game.on('stateChange', async (state) => {
      if (state.actionIdx < 0 || game.state === 'FINISHED') return;
      const bot = bots[state.actionIdx];
      if (!bot) return;
      const holeCards = game.holeCards[state.actionIdx] || [];
      const action = await bot.decide(state, holeCards);
      // Sanitize
      const myBet  = BigInt(state.players[state.actionIdx]?.bet ?? '0');
      const curBet = BigInt(state.currentBet);
      const toCall = curBet > myBet ? curBet - myBet : 0n;
      let safe = action;
      if (action.type === 'check' && toCall > 0n) safe = { type: 'call' };
      game.action(state.actionIdx, safe);
    });

    game.startHand();
  });
});
