/**
 * tableManager.js
 *
 * Manages the lifecycle of poker tables:
 *   - Table creation and lobby
 *   - Matchmaking (3-min timer once 3 players join, +30s per new join)
 *   - Player registration (real + bot)
 *   - Chip ↔ cUSD conversion
 *   - Multi-hand sessions (players rebuy or leave)
 *   - Game engine wiring
 */

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const { PokerGame }  = require('../engine/gameEngine');
const { BotPlayer, createTestBots, STRATEGIES } = require('../bots/botPlayer');

// 1 chip = $0.01 cUSD (so $1 min buy-in = 100 chips)
const CHIPS_PER_DOLLAR = 100n;

// Blind structure: 1% / 2% of min buy-in
// Default: $1 min buy-in → 100 chips → SB=1, BB=2
const DEFAULT_SMALL_BLIND = 1n;
const DEFAULT_BIG_BLIND   = 2n;

// Timers
const LOBBY_START_TIMER_MS     = 60 * 1000; // 1 min after 3rd player joins
const LOBBY_EXTRA_PLAYER_MS    = 15 * 1000; // +15s each additional player
const MIN_PLAYERS              = 3;
const MAX_PLAYERS              = 6;

class TableManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.tables        = new Map();  // tableId → TableState
    this.playerTable   = new Map();  // playerId → tableId
    this.botMode       = options.botMode ?? false;  // fill empty seats with bots
    this.onChainSync   = options.onChainSync ?? null; // async fn(tableId, action)
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  TABLE CREATION
  // ═══════════════════════════════════════════════════════════════════════

  createTable({ minBuyInUSD = 0.2, maxBuyInUSD = 0, name } = {}) {
    const tableId = uuidv4();
    const minBuyIn = BigInt(Math.round(minBuyInUSD * 100)); // in chips
    const maxBuyIn = maxBuyInUSD ? BigInt(Math.round(maxBuyInUSD * 100)) : 0n;

    const table = {
      tableId,
      name:       name || `Table #${this.tables.size + 1}`,
      state:      'LOBBY',      // LOBBY → RUNNING → FINISHED
      minBuyIn,
      maxBuyIn,
      minBuyInUSD,
      maxBuyInUSD,
      players:    [],           // { id, name, address, chips, isBot, bot? }
      spectators: [],
      game:       null,
      handCount:  0,
      lobbyTimer: null,
      startAt:    null,
      createdAt:  Date.now(),
    };

    this.tables.set(tableId, table);
    this.emit('tableCreated', { tableId, name: table.name, minBuyInUSD });
    return tableId;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  PLAYER JOIN
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * A real player joins the lobby.
   * @param {object} opts
   * @param {string} opts.tableId
   * @param {string} opts.playerId   — socket id or wallet address
   * @param {string} opts.name       — display name
   * @param {string} opts.address    — Celo wallet address
   * @param {number} opts.buyInUSD   — dollars
   * @returns {{ ok: boolean, error?: string, chips?: string }}
   */
  joinTable({ tableId, playerId, name, address, buyInUSD }) {
    const table = this.tables.get(tableId);
    if (!table) return { ok: false, error: 'Table not found' };
    if (table.state !== 'LOBBY') return { ok: false, error: 'Game already started' };
    if (table.players.length >= MAX_PLAYERS) return { ok: false, error: 'Table full' };
    if (this.playerTable.has(playerId)) return { ok: false, error: 'Already at a table' };

    const buyIn = BigInt(Math.round(buyInUSD * 100)); // chips
    if (buyIn < table.minBuyIn) return { ok: false, error: `Min buy-in is $${table.minBuyInUSD}` };
    if (table.maxBuyIn > 0n && buyIn > table.maxBuyIn) {
      return { ok: false, error: `Max buy-in is $${table.maxBuyInUSD}` };
    }

    const player = { id: playerId, name, address, chips: buyIn, isBot: false };
    table.players.push(player);
    this.playerTable.set(playerId, tableId);

    this.emit('playerJoined', { tableId, playerId, name, chips: buyIn.toString() });

    // Lobby timer logic
    this._updateLobbyTimer(table);

    return { ok: true, chips: buyIn.toString() };
  }

  /**
   * Add a bot player to a table (for testing or seat-filling).
   */
  addBot(tableId, strategy = STRATEGIES.GTO_BASIC, buyInUSD = null) {
    const table = this.tables.get(tableId);
    if (!table || table.state !== 'LOBBY') return false;
    if (table.players.length >= MAX_PLAYERS) return false;

    const buyIn = buyInUSD
      ? BigInt(Math.round(buyInUSD * 100))
      : table.minBuyIn + BigInt(Math.floor(Math.random() * 300));

    const botId = `bot_${uuidv4().slice(0, 8)}`;
    const stratLabel = strategy.slice(0, 4);
    const botName = `🤖 ${stratLabel}_${table.players.length + 1}`;

    const bot = new BotPlayer({
      playerIdx: table.players.length,
      strategy,
      name:      botName,
      thinkMin:  2000,
      thinkMax:  4000,
    });

    const player = {
      id:     botId,
      name:   botName,
      address: `0x${'b07'.repeat(13).slice(0, 40)}`, // fake address
      chips:   buyIn,
      isBot:   true,
      bot,
    };

    table.players.push(player);

    this.emit('playerJoined', {
      tableId, playerId: botId, name: botName, chips: buyIn.toString(), isBot: true,
    });

    this._updateLobbyTimer(table);
    return botId;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  LOBBY TIMER
  // ═══════════════════════════════════════════════════════════════════════

  _updateLobbyTimer(table) {
    const n = table.players.length;

    if (n < MIN_PLAYERS) {
      clearTimeout(table.lobbyTimer);
      table.startAt = null;
      return;
    }

    if (n === MIN_PLAYERS) {
      // Start 3-minute countdown
      table.startAt = Date.now() + LOBBY_START_TIMER_MS;
      clearTimeout(table.lobbyTimer);
      table.lobbyTimer = setTimeout(() => this._startGame(table.tableId), LOBBY_START_TIMER_MS);
      this.emit('lobbyTimerStarted', {
        tableId: table.tableId,
        startsAt: table.startAt,
        secondsLeft: LOBBY_START_TIMER_MS / 1000,
      });
      return;
    }

    // 4th, 5th, 6th player: add 30s to existing timer
    if (n > MIN_PLAYERS && table.startAt) {
      clearTimeout(table.lobbyTimer);
      table.startAt = Math.min(table.startAt + LOBBY_EXTRA_PLAYER_MS, Date.now() + LOBBY_START_TIMER_MS);
      const remaining = table.startAt - Date.now();
      table.lobbyTimer = setTimeout(() => this._startGame(table.tableId), remaining);
      this.emit('lobbyTimerExtended', {
        tableId: table.tableId,
        startsAt: table.startAt,
        secondsLeft: Math.round(remaining / 1000),
      });
    }

    // If already at max, start immediately
    if (n === MAX_PLAYERS) {
      clearTimeout(table.lobbyTimer);
      this._startGame(table.tableId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  GAME START
  // ═══════════════════════════════════════════════════════════════════════

  _startGame(tableId) {
    const table = this.tables.get(tableId);
    if (!table || table.state !== 'LOBBY') return;
    if (table.players.length < MIN_PLAYERS) {
      this.emit('tableCancelled', { tableId, reason: 'Not enough players' });
      table.state = 'CANCELLED';
      return;
    }

    table.state = 'RUNNING';
    clearTimeout(table.lobbyTimer);

    // Wire up game engine
    const gameConfig = {
      tableId,
      players: table.players.map((p, i) => ({
        id:      p.id,
        name:    p.name,
        chips:   p.chips.toString(),
        isBot:   p.isBot,
        address: p.address,
        index:   i,
      })),
      smallBlind: DEFAULT_SMALL_BLIND.toString(),
      bigBlind:   DEFAULT_BIG_BLIND.toString(),
      dealerPos:  0,
    };

    const game = new PokerGame(gameConfig);
    table.game = game;

    // Forward all game events to table manager subscribers
    game.on('stateChange',   state => this.emit('gameState',   { tableId, state }));
    game.on('handStarted',   data  => this.emit('handStarted', { tableId, ...data }));
    game.on('streetDealt',   data  => this.emit('streetDealt', { tableId, ...data }));
    game.on('playerAction',  data  => this.emit('playerAction',{ tableId, ...data }));
    game.on('actionTimeout', data  => this.emit('actionTimeout',{ tableId, ...data }));

    game.on('handComplete', async (result) => {
      table.handCount++;
      this.emit('handComplete', { tableId, ...result });

      // Sync with blockchain if needed
      if (this.onChainSync) {
        try { await this.onChainSync(tableId, { type: 'handComplete', ...result }); }
        catch (e) { this.emit('chainSyncError', { tableId, error: e.message }); }
      }

      // Update table player chips from game state
      const publicState = game.getPublicState();
      for (let i = 0; i < table.players.length; i++) {
        table.players[i].chips = BigInt(publicState.players[i].chips);
      }

      // Check if we should continue (auto-deal next hand after 3s)
      const stillActive = table.players.filter(p => p.chips > 0n);
      if (stillActive.length >= 2) {
        setTimeout(() => this._nextHand(tableId), 5000);
      } else {
        this._finishTable(tableId);
      }
    });

    // Wire up bot decision loop
    game.on('stateChange', (state) => {
      if (state.actionIdx < 0) return;
      const actingPlayer = table.players[state.actionIdx];
      if (actingPlayer?.isBot) {
        this._triggerBotAction(table, state, state.actionIdx);
      }
    });

    this.emit('gameStarted', {
      tableId,
      players: table.players.map(p => ({ id: p.id, name: p.name, chips: p.chips.toString(), isBot: p.isBot })),
    });

    game.startHand();
  }

  _nextHand(tableId) {
    const table = this.tables.get(tableId);
    if (!table || table.state !== 'RUNNING') return;

    // Reset game engine for next hand
    const game = table.game;
    if (!game) return;

    // Reset player hand state
    for (const p of game.players) {
      p.folded = false;
      p.allIn  = false;
    }
    game.state = 'WAITING';

    try {
      game.startHand();
    } catch (e) {
      this.emit('error', { tableId, error: e.message });
    }
  }

  _finishTable(tableId) {
    const table = this.tables.get(tableId);
    if (!table) return;
    table.state = 'FINISHED';

    // Final chip counts
    const results = table.players.map(p => ({
      id:     p.id,
      name:   p.name,
      chips:  p.chips.toString(),
      usd:    (Number(p.chips) / Number(CHIPS_PER_DOLLAR)).toFixed(2),
      isBot:  p.isBot,
    }));

    this.emit('tableFinished', { tableId, results, handCount: table.handCount });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  BOT ACTION LOOP
  // ═══════════════════════════════════════════════════════════════════════

  async _triggerBotAction(table, gameState, playerIdx) {
    const playerEntry = table.players[playerIdx];
    if (!playerEntry?.bot) return;

    const holeCards = table.game.holeCards[playerIdx];
    if (!holeCards) return;

    try {
      const action = await playerEntry.bot.decide(gameState, holeCards);

      // Safety: validate action before submitting
      const sanitized = this._sanitizeAction(action, gameState, playerIdx);
      table.game.action(playerIdx, sanitized);
    } catch (e) {
      // On any error, just fold safely
      table.game.action(playerIdx, { type: 'fold' });
    }
  }

  _sanitizeAction(action, gameState, playerIdx) {
    const player  = gameState.players[playerIdx];
    const myChips = BigInt(player?.chips ?? '0');
    const myBet   = BigInt(player?.bet   ?? '0');
    const curBet  = BigInt(gameState.currentBet);
    const toCall  = curBet > myBet ? curBet - myBet : 0n;

    switch (action.type) {
      case 'fold':  return { type: 'fold' };
      case 'check':
        return toCall === 0n ? { type: 'check' } : { type: 'call' };
      case 'call':
        return toCall === 0n ? { type: 'check' } : { type: 'call' };
      case 'allin': return { type: 'allin' };
      case 'raise':
      case 'bet': {
        const amt = BigInt(action.amount ?? 0n);
        if (amt <= 0n || amt > myChips) return { type: 'allin' };
        return { type: action.type, amount: amt };
      }
      default: return { type: 'fold' };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  HUMAN PLAYER ACTION
  // ═══════════════════════════════════════════════════════════════════════

  playerAction(tableId, playerId, action) {
    const table = this.tables.get(tableId);
    if (!table || table.state !== 'RUNNING') return { ok: false, error: 'No active game' };

    const playerIdx = table.players.findIndex(p => p.id === playerId);
    if (playerIdx < 0) return { ok: false, error: 'Player not at table' };

    return table.game.action(playerIdx, action);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  UTILITY / VIEWS
  // ═══════════════════════════════════════════════════════════════════════

  getTableState(tableId) {
    const table = this.tables.get(tableId);
    if (!table) return null;
    return {
      tableId:    table.tableId,
      name:       table.name,
      state:      table.state,
      playerCount: table.players.length,
      players:    table.players.map(p => ({
        id:    p.id,
        name:  p.name,
        chips: p.chips.toString(),
        isBot: p.isBot,
      })),
      startAt:    table.startAt,
      gameState:  table.game?.getPublicState() ?? null,
    };
  }

  getLobbyTables() {
    return [...this.tables.values()]
      .filter(t => t.state === 'LOBBY')
      .map(t => ({
        tableId:    t.tableId,
        name:       t.name,
        playerCount: t.players.length,
        minBuyInUSD: t.minBuyInUSD,
        startAt:    t.startAt,
      }));
  }

  chipsToUSD(chips) {
    return Number(chips) / Number(CHIPS_PER_DOLLAR);
  }

  usdToChips(usd) {
    return BigInt(Math.round(usd * Number(CHIPS_PER_DOLLAR)));
  }
}

module.exports = { TableManager, CHIPS_PER_DOLLAR };
