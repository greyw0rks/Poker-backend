require('dotenv').config();
const { createVoucher, redeemVoucher, getVoucherBalance, useVoucherGame, listVouchers, deactivateVoucher } = require('./voucherManager');
const { recordSession, getPlayerStats, getLeaderboard } = require('./winningsManager');
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { TableManager } = require('./tableManager');
const { STRATEGIES }   = require('../bots/botPlayer');
const vouchers         = require('./voucherManager');

const PORT      = process.env.PORT || 8080;
const DEV_MODE  = process.env.NODE_ENV !== 'production';
const ADMIN_KEY = process.env.ADMIN_KEY || 'celopoker-admin-2025';

// ── On-chain payment verification ─────────────────────────────────────────────
// Uses raw JSON-RPC via Node 18 built-in fetch — no extra dependencies needed.

const CELO_RPC    = process.env.CELO_RPC_URL || 'https://forno.celo.org';
let   _rpcId      = 1;

// Prevent the same tx from being used to join twice
const usedTxHashes = new Set();

// keccak256("Transfer(address,address,uint256)") — standard on every ERC-20
const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function rpcCall(method, params) {
  const res = await fetch(CELO_RPC, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: _rpcId++, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

/**
 * Verify an ERC-20 buy-in transaction before seating a player.
 *
 * Checks:
 *   1. Tx exists and succeeded on Celo mainnet
 *   2. tx.from matches the player's wallet address
 *   3. A Transfer log goes to the poker contract for >= buyInUSD  (when POKER_CONTRACT_ADDRESS is set)
 *
 * @param {string} txHash      - 0x-prefixed transaction hash from the client
 * @param {string} fromAddress - player's wallet address
 * @param {number} buyInUSD    - required buy-in in USD (e.g. 1.00)
 * @returns {{ ok: boolean, error?: string }}
 */
async function verifyPaymentTx(txHash, fromAddress, buyInUSD) {
  try {
    const [receipt, tx] = await Promise.all([
      rpcCall('eth_getTransactionReceipt', [txHash]),
      rpcCall('eth_getTransactionByHash',  [txHash]),
    ]);

    if (!receipt || receipt.status !== '0x1') {
      return { ok: false, error: 'Transaction not found or failed on-chain' };
    }

    if (tx.from.toLowerCase() !== fromAddress.toLowerCase()) {
      return { ok: false, error: 'Transaction sender does not match your wallet address' };
    }

    const contractAddr = process.env.POKER_CONTRACT_ADDRESS;
    if (contractAddr) {
      // Accept transfers from any supported MiniPay stablecoin
      const SUPPORTED_TOKENS = new Set([
        '0x765de816845861e75a25fca122bb6898b8b1282a', // USDm (cUSD)
        '0xceba9300f2b948710d2651d74d2caa7e55d70e73', // USDC
        '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', // USDT
      ]);
      const requiredWei   = BigInt(Math.round(buyInUSD * 1e18));
      const contractLower = contractAddr.toLowerCase();

      const transferLog = (receipt.logs || []).find(log => {
        if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC) return false;
        if (!SUPPORTED_TOKENS.has(log.address?.toLowerCase())) return false;
        const toAddr = '0x' + log.topics[2]?.slice(26);
        if (toAddr.toLowerCase() !== contractLower) return false;
        return BigInt(log.data) >= requiredWei;
      });

      if (!transferLog) {
        return {
          ok: false,
          error: `No valid buy-in transfer found. Please send at least $${buyInUSD} in USDm, USDC, or USDT to the game contract.`,
        };
      }
    }

    return { ok: true };
  } catch (e) {
    console.error('[PaymentVerify]', e.message);
    return { ok: false, error: 'Could not verify transaction. Please try again.' };
  }
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'OPTIONS'] },
});

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

const manager = new TableManager({ botMode: DEV_MODE });

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Invalid admin key' });
  next();
}

// ── Manager events → sockets ─────────────────────────────────────────────────
manager.on('tableCreated',       ()  => io.emit('table_list', manager.getLobbyTables()));
manager.on('playerJoined',       d   => io.to(d.tableId).emit('player_joined', d));
manager.on('lobbyTimerStarted',  d   => {
  io.to(d.tableId).emit('lobby_timer', d);
  io.emit('table_list', manager.getLobbyTables());
});
manager.on('lobbyTimerExtended', d   => io.to(d.tableId).emit('lobby_timer', d));

manager.on('gameStarted', d => {
  io.to(d.tableId).emit('game_started', d);
  setTimeout(() => {
    const room = io.sockets.adapter.rooms.get(d.tableId);
    if (!room) return;
    Array.from(room).forEach(socketId => {
      const sock = io.sockets.sockets.get(socketId);
      const pidx = sock && sock.data && sock.data.playerIdx;
      if (pidx === undefined || pidx < 0) return;
      const table = manager.tables && manager.tables.get(d.tableId);
      if (!table || !table.game) return;
      const cards = table.game.getHoleCards(pidx);
      if (cards && cards.length > 0) {
        sock.emit('hole_cards', { tableId: d.tableId, cards });
        console.log('[gameStarted] Sent cards to seat', pidx);
      }
    });
  }, 800);
});

manager.on('gameState',    d => io.to(d.tableId).emit('game_state', d));
manager.on('streetDealt',  d => io.to(d.tableId).emit('street_dealt', d));
manager.on('playerAction', d => io.to(d.tableId).emit('player_action', d));
manager.on('actionTimeout',d => io.to(d.tableId).emit('action_timeout', d));
manager.on('handComplete', d => io.to(d.tableId).emit('hand_complete', d));

manager.on('handStarted', d => {
  io.to(d.tableId).emit('hand_started', d);
  const room = io.sockets.adapter.rooms.get(d.tableId);
  if (!room) return;
  Array.from(room).forEach(socketId => {
    const sock  = io.sockets.sockets.get(socketId);
    const pidx  = sock && sock.data && sock.data.playerIdx;
    if (pidx === undefined || pidx < 0) return;
    const cards = d.holeCards && d.holeCards[pidx] &&
      (d.holeCards[pidx].cards || d.holeCards[pidx]);
    if (cards && cards.length > 0) {
      sock.emit('hole_cards', { tableId: d.tableId, cards });
    }
  });
});

manager.on('tableFinished', d => {
  io.to(d.tableId).emit('table_finished', d);
  const results = d.results || [];
  const maxChips = Math.max(...results.map(r => Number(r.chips)));
  io.to(d.tableId).emit('game_over', {
    tableId:   d.tableId,
    handCount: d.handCount,
    results:   results.map(r => ({
      name:       r.name,
      isBot:      r.isBot,
      finalChips: Number(r.chips),
      finalUSD:   r.usd,
      isWinner:   Number(r.chips) === maxChips && maxChips > 0,
    })),
    redirectIn: 8,
  });
});

manager.on('tableCancelled', d => io.to(d.tableId).emit('error', { message: 'Table cancelled' }));

// ── REST ─────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));
app.get('/tables', (req, res) => res.json(manager.getLobbyTables()));
app.get('/tables/:id', (req, res) => {
  const state = manager.getTableState(req.params.id);
  if (!state) return res.status(404).json({ error: 'Table not found' });
  res.json(state);
});

app.post('/dev/bot-table', (req, res) => {
  if (!DEV_MODE) return res.status(403).json({ error: 'Dev only' });
  const { playerCount = 4, minBuyInUSD = 1 } = req.body;
  const strategies = [STRATEGIES.GTO_BASIC, STRATEGIES.AGGRESSIVE, STRATEGIES.CALL_STATION, STRATEGIES.RANDOM];
  const tableId = manager.createTable({ minBuyInUSD, name: 'Bot Test Table' });
  const botIds  = [];
  for (let i = 0; i < Math.max(3, Math.min(6, playerCount)); i++) {
    botIds.push(manager.addBot(tableId, strategies[i % strategies.length], minBuyInUSD + Math.random() * 5));
  }
  res.json({ tableId, botIds });
});

app.post('/dev/human-bot-table', (req, res) => {
  if (!DEV_MODE) return res.status(403).json({ error: 'Dev only' });
  const { humanName = 'Player', botCount = 3, minBuyInUSD = 1 } = req.body;
  const strategies = [STRATEGIES.GTO_BASIC, STRATEGIES.AGGRESSIVE, STRATEGIES.CALL_STATION, STRATEGIES.RANDOM];
  const tableId       = manager.createTable({ minBuyInUSD, name: 'CeloPoker Table' });
  const humanPlayerId = 'human_pending_' + tableId.slice(0, 8);
  manager.joinTable({ tableId, playerId: humanPlayerId, name: humanName, address: '0xHUMAN', buyInUSD: minBuyInUSD });
  for (let i = 0; i < Math.min(5, Math.max(1, botCount)); i++)
    manager.addBot(tableId, strategies[i % strategies.length], minBuyInUSD + Math.random() * 4);
  res.json({ tableId, humanPlayerId, humanSlot: 0 });
});

// ── Voucher public ────────────────────────────────────────────────────────────
app.post('/voucher/redeem', (req, res) => {
  const { code, address } = req.body;
  if (!code || !address) return res.status(400).json({ error: 'code and address required' });
  try { res.json(vouchers.redeemVoucher(code, address)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/voucher/balance/:address', (req, res) => {
  res.json(vouchers.getVoucherBalance(req.params.address));
});

// ── Voucher admin ─────────────────────────────────────────────────────────────
app.post('/admin/voucher/create', requireAdmin, (req, res) => {
  const { code, maxClaims = 20, gamesPerClaim = 3, buyInUSD = 1, expiryDays = 7 } = req.body;
  try {
    const v = vouchers.createVoucher({ code, maxClaims, gamesPerClaim, buyInPerGame: buyInUSD, daysValid: expiryDays });
    console.log('[Voucher] Created:', v.code);
    res.json({ ok: true, voucher: v });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/admin/voucher/list', requireAdmin, (req, res) => res.json(vouchers.listVouchers()));

app.get('/admin/voucher/:code', requireAdmin, (req, res) => {
  const all   = vouchers.listVouchers();
  const stats = all.find(v => v.code === req.params.code.toUpperCase());
  if (!stats) return res.status(404).json({ error: 'Not found' });
  res.json(stats);
});

app.post('/admin/voucher/deactivate', requireAdmin, (req, res) => {
  res.json({ ok: vouchers.deactivateVoucher(req.body.code) });
});


// ── Difficulty rooms ──────────────────────────────────────────────────────────
app.post('/rooms/create', async (req, res) => {
  const { hostName, difficulty, address, txHash } = req.body;
  if (!hostName || !difficulty) return res.status(400).json({ error: 'Missing fields' });

  // ── Payment gate ────────────────────────────────────────────────────────────
  // Private rooms are free (friends play together, no buy-in).
  // All other difficulties require a verified on-chain transfer.
  if (difficulty !== 'private' && address && !address.startsWith('0xDEV') && address !== '0xHOST') {
    if (!txHash) {
      return res.status(402).json({ error: 'Payment required. Please send your buy-in first.' });
    }
    if (usedTxHashes.has(txHash)) {
      return res.status(400).json({ error: 'This transaction has already been used.' });
    }
    // Look up buyInUSD for this difficulty to verify correct amount
    const DIFF_BUYIN = { easy: 0.10, normal: 0.15, hard: 0.50, super: 1.00 };
    const expectedBuyIn = DIFF_BUYIN[difficulty];
    if (expectedBuyIn !== undefined) {
      const verified = await verifyPaymentTx(txHash, address, expectedBuyIn);
      if (!verified.ok) {
        return res.status(402).json({ error: verified.error });
      }
      usedTxHashes.add(txHash);
    }
  }
  // ───────────────────────────────────────────────────────────────────────────
  const DIFFS = {
    easy:    { buyInUSD: 0.10, label: 'Easy Table',    bots: 3 },
    normal:  { buyInUSD: 0.15, label: 'Normal Table',  bots: 3 },
    hard:    { buyInUSD: 0.50, label: 'Hard Table',    bots: 3 },
    super:   { buyInUSD: 1.00, label: 'Super Table',   bots: 3 },
    private: { buyInUSD: 0.20, label: 'Private Table', bots: 0 },
  };
  const diff = DIFFS[difficulty];
  if (!diff) return res.status(400).json({ error: 'Invalid difficulty' });

  const code    = Math.random().toString(36).slice(2, 8).toUpperCase();
  const tableId = manager.createTable({ minBuyInUSD: diff.buyInUSD, name: diff.label });
  const table   = manager.tables.get(tableId);
  if (table) {
    table.roomCode  = code;
    table.difficulty = difficulty;
    table.isPrivate  = difficulty === 'private';
    table.hostName   = hostName;
  }

  const strategies = [STRATEGIES.GTO_BASIC, STRATEGIES.AGGRESSIVE, STRATEGIES.CALL_STATION, STRATEGIES.RANDOM];
  if (diff.bots > 0) {
    for (let i = 0; i < diff.bots; i++)
      manager.addBot(tableId, strategies[i % strategies.length], diff.buyInUSD);
  }

  const humanPlayerId = 'human_pending_' + tableId.slice(0, 8);
  manager.joinTable({
    tableId, playerId: humanPlayerId,
    name: hostName, address: address || '0xHOST',
    buyInUSD: diff.buyInUSD,
  });

  res.json({ tableId, code, humanPlayerId, difficulty, buyInUSD: diff.buyInUSD, label: diff.label, onChainTableId: null });
});

app.get('/rooms/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  for (const [tableId, table] of manager.tables) {
    if (table.roomCode === code)
      return res.json({
        found: true, tableId, name: table.name, state: table.state,
        difficulty: table.difficulty, buyInUSD: table.minBuyInUSD,
        playerCount: table.players.length,
      });
  }
  res.status(404).json({ found: false, error: 'Room not found or expired' });
});

app.get('/rooms', (req, res) => {
  const rooms = [];
  for (const [tableId, table] of manager.tables) {
    if (table.roomCode && table.state === 'LOBBY')
      rooms.push({
        tableId, code: table.roomCode, name: table.name,
        difficulty: table.difficulty, playerCount: table.players.length,
        isPrivate: table.isPrivate, hostName: table.hostName, startAt: table.startAt,
      });
  }
  res.json(rooms);
});

// ── Stats & Leaderboard ───────────────────────────────────────────────────────
app.get('/leaderboard', (req, res) => {
  try { res.json(getLeaderboard()); } catch (e) { res.json([]); }
});

app.get('/stats/:address', (req, res) => {
  try { res.json(getPlayerStats(req.params.address)); } catch (e) { res.json({ sessions: 0, totalWonUSD: 0, netUSD: 0 }); }
});

// ── Voucher routes (match frontend calls) ─────────────────────────────────────
app.post('/vouchers/redeem', (req, res) => {
  const { code, address } = req.body;
  if (!code || !address) return res.status(400).json({ error: 'Missing code or address' });
  try { res.json(redeemVoucher(code, address)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/vouchers/balance/:address', (req, res) => {
  try { res.json(getVoucherBalance(req.params.address)); }
  catch (e) { res.json({ hasBalance: false, gamesLeft: 0 }); }
});

app.post('/admin/vouchers', (req, res) => {
  const { secret, code, gamesPerClaim, maxClaims, buyInPerGame, daysValid } = req.body;
  if (secret !== (process.env.ADMIN_SECRET || 'celopoker_admin'))
    return res.status(403).json({ error: 'Unauthorized' });
  res.json(createVoucher({ code, gamesPerClaim, maxClaims, buyInPerGame, daysValid }));
});

app.get('/admin/vouchers', (req, res) => {
  if (req.query.secret !== (process.env.ADMIN_SECRET || 'celopoker_admin'))
    return res.status(403).json({ error: 'Unauthorized' });
  res.json(listVouchers());
});

app.delete('/admin/vouchers/:code', (req, res) => {
  if (req.query.secret !== (process.env.ADMIN_SECRET || 'celopoker_admin'))
    return res.status(403).json({ error: 'Unauthorized' });
  res.json(deactivateVoucher(req.params.code));
});


// ── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[+]', socket.id);
  socket.emit('connected', { socketId: socket.id });

  socket.on('join_table', async ({ tableId, name, address, buyInUSD, humanPlayerId, txHash }) => {
    if (!tableId || !name) return socket.emit('error', { message: 'Missing fields' });

    if (humanPlayerId) {
      const table = manager.tables && manager.tables.get(tableId);
      if (table) {
        const pIdx = table.players.findIndex(p => p.id === humanPlayerId);
        if (pIdx >= 0) {
          table.players[pIdx].id      = socket.id;
          table.players[pIdx].address = address || socket.id;
          table.players[pIdx].name    = name;
          manager.playerTable.set(socket.id, tableId);
          socket.join(tableId);
          socket.data.tableId   = tableId;
          socket.data.playerId  = socket.id;
          socket.data.playerIdx = pIdx;
          socket.data.address   = address || socket.id;
          socket.emit('join_ok', {
            tableId, playerIdx: pIdx,
            chips: table.players[pIdx].chips.toString(),
            tableState: manager.getTableState(tableId),
          });
          console.log('[Table ' + tableId.slice(0,8) + '] ' + name + ' → seat ' + pIdx);
          return;
        }
      }
    }

    const effectiveAddr  = address || socket.id;
    const effectiveBuyIn = buyInUSD || 1;

    // Check voucher balance before joining
    const vBal = vouchers.getVoucherBalance(effectiveAddr);
    let usedVoucher = false;
    if (vBal.gamesLeft > 0 && effectiveBuyIn <= (vBal.usdPerGame || 999)) {
      const used = vouchers.useVoucherGame(effectiveAddr);
      if (used.ok) { usedVoucher = true; }
    }

    // ── Payment gate ──────────────────────────────────────────────────────
    // Voucher players are paid via their credit. Everyone else must provide
    // a verified on-chain transaction hash.
    if (!usedVoucher) {
      if (!txHash) {
        return socket.emit('error', {
          message: `Buy-in of $${effectiveBuyIn} required. Send USDm to the game contract and include your transaction hash.`,
        });
      }
      if (usedTxHashes.has(txHash)) {
        return socket.emit('error', { message: 'This transaction has already been used to join a table.' });
      }
      const verified = await verifyPaymentTx(txHash, effectiveAddr, effectiveBuyIn);
      if (!verified.ok) {
        return socket.emit('error', { message: verified.error });
      }
      usedTxHashes.add(txHash);
    }
    // ─────────────────────────────────────────────────────────────────────

    const result = manager.joinTable({
      tableId, playerId: socket.id, name,
      address: effectiveAddr, buyInUSD: Number(effectiveBuyIn),
    });
    if (!result.ok) return socket.emit('error', { message: result.error });

    socket.join(tableId);
    socket.data.tableId  = tableId;
    socket.data.playerId = socket.id;
    socket.data.address  = effectiveAddr;

    const ts   = manager.getTableState(tableId);
    const pIdx = ts?.players?.findIndex(p => p.id === socket.id);
    socket.data.playerIdx = pIdx >= 0 ? pIdx : undefined;

    socket.emit('join_ok', {
      tableId, chips: result.chips, playerIdx: socket.data.playerIdx,
      usedVoucher,
      voucherGamesLeft: vBal.gamesLeft - (usedVoucher ? 1 : 0),
      tableState: ts,
    });
  });

  socket.on('action', ({ tableId, type, amount }) => {
    const tid = tableId || socket.data.tableId;
    if (!tid) return socket.emit('error', { message: 'Not at a table' });
    const amtBig = amount !== undefined ? BigInt(String(amount)) : undefined;
    const result = manager.playerAction(tid, socket.id, { type, amount: amtBig });
    if (!result?.ok) socket.emit('error', { message: result?.error ?? 'Action failed' });
  });

  socket.on('get_state', ({ tableId }) => {
    const state = manager.getTableState(tableId || socket.data.tableId);
    if (state) socket.emit('table_state', state);
  });

  socket.on('get_cards', ({ tableId }) => {
    const tid   = tableId || socket.data.tableId;
    const table = manager.tables && manager.tables.get(tid);
    if (!table || !table.game) return;
    const pIdx = socket.data.playerIdx;
    if (pIdx === undefined || pIdx < 0) return;
    const cards = table.game.getHoleCards(pIdx);
    if (cards && cards.length > 0) socket.emit('hole_cards', { tableId: tid, cards });
  });

  socket.on('disconnect', () => {
    console.log('[-]', socket.id);
    const { tableId, playerIdx } = socket.data;
    if (tableId && playerIdx !== undefined) {
      const table = manager.tables && manager.tables.get(tableId);
      if (table && table.game && !['WAITING','FINISHED'].includes(table.game.state))
        table.game.forceAction(playerIdx);
    }
  });
});


// Keep-alive: Railway kills idle processes — ping self every 4 minutes
if (process.env.NODE_ENV === 'production' && process.env.RAILWAY_PUBLIC_DOMAIN) {
  const https = require('https');
  setInterval(() => {
    try {
      https.get('https://' + process.env.RAILWAY_PUBLIC_DOMAIN + '/health', () => {}).on('error', () => {});
    } catch (_) {}
  }, 4 * 60 * 1000);
}

server.listen(PORT, () => {
  console.log(`\n🃏  Poker Backend  port ${PORT}  [${DEV_MODE ? 'DEV' : 'PROD'}]`);
  console.log(`   Admin key : ${ADMIN_KEY}`);
  console.log(`   Health    : http://localhost:${PORT}/health\n`);
});

module.exports = { app, server, manager, io };
