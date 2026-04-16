require('dotenv').config();
const { createVoucher, redeemVoucher, getVoucherBalance, useVoucherGame, listVouchers, deactivateVoucher } = require('./voucherManager');
const { recordSession, getPlayerStats, getLeaderboard } = require('./winningsManager');
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { TableManager } = require('./tableManager');
const { STRATEGIES }   = require('../bots/botPlayer');
const vouchers         = require('./voucherManager');

const PORT      = process.env.PORT || 3001;
const DEV_MODE  = process.env.NODE_ENV !== 'production';
const ADMIN_KEY = process.env.ADMIN_KEY || 'celopoker-admin-2025';

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
  res.json(vouchers.getWalletBalance(req.params.address));
});

// ── Voucher admin ─────────────────────────────────────────────────────────────
app.post('/admin/voucher/create', requireAdmin, (req, res) => {
  const { code, maxClaims = 20, gamesPerClaim = 3, buyInUSD = 1, expiryDays = 7 } = req.body;
  try {
    const v = vouchers.createVoucher({ code, maxClaims, gamesPerClaim, buyInUSD, expiryDays });
    console.log('[Voucher] Created:', v.code);
    res.json({ ok: true, voucher: v });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

app.get('/admin/voucher/list', requireAdmin, (req, res) => res.json(vouchers.listVouchers()));

app.get('/admin/voucher/:code', requireAdmin, (req, res) => {
  const stats = vouchers.getVoucherStats(req.params.code.toUpperCase());
  if (!stats) return res.status(404).json({ error: 'Not found' });
  res.json(stats);
});

app.post('/admin/voucher/deactivate', requireAdmin, (req, res) => {
  res.json({ ok: vouchers.deactivateVoucher(req.body.code) });
});

// ── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[+]', socket.id);
  socket.emit('connected', { socketId: socket.id });

  socket.on('join_table', ({ tableId, name, address, buyInUSD, humanPlayerId }) => {
    if (!tableId || !name) return socket.emit('error', { message: 'Missing fields' });

    if (humanPlayerId && DEV_MODE) {
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
    const vBal = vouchers.getWalletBalance(effectiveAddr);
    let usedVoucher = false;
    if (vBal.gamesLeft > 0 && effectiveBuyIn <= vBal.buyInUSD) {
      const used = vouchers.useGame(effectiveAddr);
      if (used.used) { usedVoucher = true; }
    }

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

server.listen(PORT, () => {
  console.log(`\n🃏  Poker Backend  port ${PORT}  [${DEV_MODE ? 'DEV' : 'PROD'}]`);
  console.log(`   Admin key : ${ADMIN_KEY}`);
  console.log(`   Health    : http://localhost:${PORT}/health\n`);
});

module.exports = { app, server, manager, io };
