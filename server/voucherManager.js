/**
 * voucherManager.js
 * 
 * Simple file-based voucher system.
 * No database needed — JSON file stores all voucher state.
 * 
 * Voucher schema:
 * {
 *   code: "CELO2025",
 *   gamesPerClaim: 3,
 *   maxClaims: 20,
 *   buyInPerGame: 1,        // USD, not withdrawable
 *   expiresAt: 1234567890,  // unix timestamp
 *   claims: [               // array of wallet addresses that claimed
 *     { address: "0x...", claimedAt: 123, gamesLeft: 3 }
 *   ]
 * }
 */

const fs   = require('fs');
const path = require('path');

const VOUCHER_FILE = path.join(__dirname, '../data/vouchers.json');
const BALANCE_FILE = path.join(__dirname, '../data/voucherBalances.json');

// Ensure data directory exists
function ensureDataDir() {
  const dir = path.join(__dirname, '../data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadVouchers() {
  ensureDataDir();
  if (!fs.existsSync(VOUCHER_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(VOUCHER_FILE, 'utf8')); }
  catch { return []; }
}

function saveVouchers(v) {
  ensureDataDir();
  fs.writeFileSync(VOUCHER_FILE, JSON.stringify(v, null, 2));
}

function loadBalances() {
  ensureDataDir();
  if (!fs.existsSync(BALANCE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(BALANCE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveBalances(b) {
  ensureDataDir();
  fs.writeFileSync(BALANCE_FILE, JSON.stringify(b, null, 2));
}

// ── Admin: create a voucher batch ─────────────────────────────────────────────
function createVoucher({ code, gamesPerClaim = 3, maxClaims = 20, buyInPerGame = 1, daysValid = 7 }) {
  const vouchers = loadVouchers();
  if (vouchers.find(v => v.code === code)) {
    return { ok: false, error: 'Code already exists' };
  }
  const voucher = {
    code: code.toUpperCase(),
    gamesPerClaim,
    maxClaims,
    buyInPerGame,
    expiresAt: Date.now() + daysValid * 24 * 60 * 60 * 1000,
    claims: [],
    active: true,
  };
  vouchers.push(voucher);
  saveVouchers(vouchers);
  return { ok: true, voucher };
}

// ── Player: redeem a voucher ──────────────────────────────────────────────────
function redeemVoucher(code, walletAddress) {
  const vouchers = loadVouchers();
  const v = vouchers.find(v => v.code === code.toUpperCase());

  if (!v)           return { ok: false, error: 'Invalid code' };
  if (!v.active)    return { ok: false, error: 'Voucher is deactivated' };
  if (Date.now() > v.expiresAt) return { ok: false, error: 'Voucher has expired' };
  if (v.claims.length >= v.maxClaims) return { ok: false, error: 'Voucher fully claimed' };

  const addr = walletAddress.toLowerCase();
  if (v.claims.find(c => c.address === addr)) {
    return { ok: false, error: 'You have already used this voucher' };
  }

  // Record claim
  v.claims.push({ address: addr, claimedAt: Date.now(), gamesLeft: v.gamesPerClaim });
  saveVouchers(vouchers);

  // Credit balance
  const balances = loadBalances();
  if (!balances[addr]) balances[addr] = { gamesLeft: 0, usdPerGame: v.buyInPerGame };
  balances[addr].gamesLeft += v.gamesPerClaim;
  balances[addr].usdPerGame = v.buyInPerGame;
  saveBalances(balances);

  return {
    ok: true,
    gamesLeft:  balances[addr].gamesLeft,
    usdPerGame: v.buyInPerGame,
    message:    `You got ${v.gamesPerClaim} free games! (${v.maxClaims - v.claims.length} claims remaining)`,
  };
}

// ── Check if address has voucher balance ──────────────────────────────────────
function getVoucherBalance(walletAddress) {
  const balances = loadBalances();
  const b = balances[walletAddress.toLowerCase()];
  if (!b || b.gamesLeft <= 0) return { hasBalance: false, gamesLeft: 0 };
  return { hasBalance: true, gamesLeft: b.gamesLeft, usdPerGame: b.usdPerGame };
}

// ── Deduct one game from balance ──────────────────────────────────────────────
function useVoucherGame(walletAddress) {
  const balances = loadBalances();
  const addr = walletAddress.toLowerCase();
  const b = balances[addr];
  if (!b || b.gamesLeft <= 0) return { ok: false, error: 'No voucher balance' };
  b.gamesLeft--;
  saveBalances(balances);
  return { ok: true, gamesLeft: b.gamesLeft };
}

// ── Admin: list all vouchers ──────────────────────────────────────────────────
function listVouchers() {
  return loadVouchers().map(v => ({
    code:       v.code,
    claims:     v.claims.length,
    maxClaims:  v.maxClaims,
    remaining:  v.maxClaims - v.claims.length,
    expiresAt:  new Date(v.expiresAt).toISOString(),
    expired:    Date.now() > v.expiresAt,
    active:     v.active,
    gamesPerClaim: v.gamesPerClaim,
  }));
}

// ── Admin: deactivate a voucher ───────────────────────────────────────────────
function deactivateVoucher(code) {
  const vouchers = loadVouchers();
  const v = vouchers.find(v => v.code === code.toUpperCase());
  if (!v) return { ok: false, error: 'Not found' };
  v.active = false;
  saveVouchers(vouchers);
  return { ok: true };
}

module.exports = {
  createVoucher, redeemVoucher, getVoucherBalance,
  useVoucherGame, listVouchers, deactivateVoucher,
};
