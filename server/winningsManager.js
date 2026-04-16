/**
 * winningsManager.js
 * 
 * Tracks player winnings across games.
 * When a hand completes, net winnings (chips won - chips lost) are recorded.
 * On mainnet, the contract pays out automatically via batchPayout().
 * This file keeps a local ledger for the UI to display.
 */

const fs   = require('fs');
const path = require('path');

const WINNINGS_FILE = path.join(__dirname, '../data/winnings.json');

function ensureDataDir() {
  const dir = path.join(__dirname, '../data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(WINNINGS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(WINNINGS_FILE, 'utf8')); }
  catch { return {}; }
}

function save(data) {
  ensureDataDir();
  fs.writeFileSync(WINNINGS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Record results from a completed table session.
 * @param {object[]} results  - [{ address, name, finalChips, initialChips, isBot }]
 * @param {number}   chipsPerUSD - default 100
 */
function recordSession(results, chipsPerUSD = 100) {
  const data = load();
  const now  = Date.now();

  for (const r of results) {
    if (r.isBot || !r.address) continue;
    const addr = r.address.toLowerCase();
    if (!data[addr]) {
      data[addr] = { name: r.name, sessions: [], totalWonUSD: 0, totalLostUSD: 0 };
    }

    const netChips  = (r.finalChips || 0) - (r.initialChips || 0);
    const netUSD    = netChips / chipsPerUSD;
    const session   = {
      ts:          now,
      netChips,
      netUSD:      parseFloat(netUSD.toFixed(2)),
      finalChips:  r.finalChips || 0,
      initialChips: r.initialChips || 0,
    };

    data[addr].sessions.push(session);
    if (netUSD > 0) data[addr].totalWonUSD  += netUSD;
    else            data[addr].totalLostUSD += Math.abs(netUSD);
    data[addr].name = r.name; // keep fresh
  }

  save(data);
}

/**
 * Get player stats.
 */
function getPlayerStats(address) {
  const data = load();
  const d = data[address.toLowerCase()];
  if (!d) return { totalWonUSD: 0, totalLostUSD: 0, sessions: [], netUSD: 0 };
  return {
    ...d,
    netUSD: parseFloat((d.totalWonUSD - d.totalLostUSD).toFixed(2)),
    recentSessions: d.sessions.slice(-10).reverse(),
  };
}

/**
 * Get leaderboard — top 10 by total won.
 */
function getLeaderboard() {
  const data = load();
  return Object.entries(data)
    .map(([addr, d]) => ({
      address:      addr,
      name:         d.name,
      totalWonUSD:  parseFloat(d.totalWonUSD.toFixed(2)),
      netUSD:       parseFloat((d.totalWonUSD - d.totalLostUSD).toFixed(2)),
      sessions:     d.sessions.length,
    }))
    .sort((a, b) => b.totalWonUSD - a.totalWonUSD)
    .slice(0, 10);
}

module.exports = { recordSession, getPlayerStats, getLeaderboard };
