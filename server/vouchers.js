/**
 * vouchers.js
 *
 * Simple file-based voucher system.
 * No database needed for 20 vouchers.
 *
 * Voucher schema:
 * {
 *   code:          "CELO2025",
 *   maxClaims:     20,           // max wallets that can use this code
 *   gamesPerClaim: 3,            // free games per wallet
 *   buyInPerGame:  1.00,         // USD covered per game (not withdrawable)
 *   expiresAt:     1234567890,   // unix timestamp
 *   claims:        [{ address, claimedAt, gamesLeft, gamesUsed }],
 * }
 *
 * Admin: POST /admin/vouchers        { code, maxClaims, gamesPerClaim, buyInPerGame, days }
 * Admin: GET  /admin/vouchers        list all vouchers + claim status
 * Player: POST /vouchers/redeem      { code, address }
 * Player: GET  /vouchers/balance/:address
 */

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'data', 'vouchers.json');

// Ensure data directory exists
function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadVouchers() {
  ensureDataDir();
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return []; }
}

function saveVouchers(vouchers) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(vouchers, null, 2));
}

// ─── Admin ────────────────────────────────────────────────────────────────────

/**
 * Create a new voucher batch.
 * @param {object} opts
 * @param {string} opts.code          - voucher code (e.g. "CELO2025")
 * @param {number} opts.maxClaims     - max wallets (default 20)
 * @param {number} opts.gamesPerClaim - free games per wallet (default 3)
 * @param {number} opts.buyInPerGame  - USD per game (default 1)
 * @param {number} opts.days          - expiry in days (default 7)
 */
function createVoucher({ code, maxClaims = 20, gamesPerClaim = 3, buyInPerGame = 1, days = 7 }) {
  const vouchers = loadVouchers();

  const upper = code.toUpperCase().trim();
  if (vouchers.find(v => v.code === upper)) {
    throw new Error(`Voucher code "${upper}" already exists`);
  }

  const voucher = {
    code:          upper,
    maxClaims:     Number(maxClaims),
    gamesPerClaim: Number(gamesPerClaim),
    buyInPerGame:  Number(buyInPerGame),
    expiresAt:     Date.now() + days * 24 * 60 * 60 * 1000,
    createdAt:     Date.now(),
    claims:        [],
  };

  vouchers.push(voucher);
  saveVouchers(vouchers);

  console.log(`[Voucher] Created: ${upper} | ${maxClaims} claims | ${gamesPerClaim} games | $${buyInPerGame}/game | ${days}d`);
  return voucher;
}

function listVouchers() {
  return loadVouchers().map(v => ({
    ...v,
    claimsUsed:  v.claims.length,
    claimsLeft:  v.maxClaims - v.claims.length,
    expired:     Date.now() > v.expiresAt,
    expiresIn:   Math.max(0, Math.round((v.expiresAt - Date.now()) / (1000 * 60 * 60))),
  }));
}

// ─── Player ───────────────────────────────────────────────────────────────────

/**
 * Redeem a voucher code for a wallet address.
 * Returns the claim object { gamesLeft, buyInPerGame } or throws.
 */
function redeemVoucher(code, address) {
  const vouchers = loadVouchers();
  const upper    = code.toUpperCase().trim();
  const addrLow  = address.toLowerCase();

  const v = vouchers.find(v => v.code === upper);
  if (!v)                                throw new Error('Invalid voucher code');
  if (Date.now() > v.expiresAt)          throw new Error('Voucher has expired');
  if (v.claims.length >= v.maxClaims)    throw new Error('Voucher is fully claimed');

  const existing = v.claims.find(c => c.address.toLowerCase() === addrLow);
  if (existing) throw new Error('You have already claimed this voucher');

  const claim = {
    address:   address,
    claimedAt: Date.now(),
    gamesLeft: v.gamesPerClaim,
    gamesUsed: 0,
    buyInPerGame: v.buyInPerGame,
  };

  v.claims.push(claim);
  saveVouchers(vouchers);

  console.log(`[Voucher] Claimed: ${upper} by ${address.slice(0,8)}… | ${v.gamesPerClaim} games`);
  return {
    code:         upper,
    gamesLeft:    claim.gamesLeft,
    gamesUsed:    0,
    buyInPerGame: claim.buyInPerGame,
    totalCreditUSD: claim.gamesLeft * claim.buyInPerGame,
  };
}

/**
 * Get voucher balance for a wallet address across ALL vouchers.
 */
function getVoucherBalance(address) {
  const addrLow  = address.toLowerCase();
  const vouchers = loadVouchers();
  const now      = Date.now();

  let totalGamesLeft = 0;
  let totalCreditUSD = 0;
  const activeClaims = [];

  for (const v of vouchers) {
    if (now > v.expiresAt) continue; // expired voucher
    const claim = v.claims.find(c => c.address.toLowerCase() === addrLow);
    if (!claim || claim.gamesLeft <= 0) continue;

    totalGamesLeft += claim.gamesLeft;
    totalCreditUSD += claim.gamesLeft * v.buyInPerGame;
    activeClaims.push({
      code:         v.code,
      gamesLeft:    claim.gamesLeft,
      gamesUsed:    claim.gamesUsed,
      buyInPerGame: v.buyInPerGame,
      expiresAt:    v.expiresAt,
    });
  }

  return { address, totalGamesLeft, totalCreditUSD, claims: activeClaims };
}

/**
 * Use one game credit for an address (called when game starts).
 * Returns true if credit was available and consumed, false otherwise.
 */
function useGameCredit(address, buyInUSD = 1) {
  const addrLow  = address.toLowerCase();
  const vouchers = loadVouchers();
  const now      = Date.now();

  for (const v of vouchers) {
    if (now > v.expiresAt) continue;
    if (Math.abs(v.buyInPerGame - buyInUSD) > 0.01) continue; // wrong denomination

    const claimIdx = v.claims.findIndex(c => c.address.toLowerCase() === addrLow && c.gamesLeft > 0);
    if (claimIdx < 0) continue;

    v.claims[claimIdx].gamesLeft--;
    v.claims[claimIdx].gamesUsed++;
    saveVouchers(vouchers);

    console.log(`[Voucher] Used game credit: ${v.code} for ${address.slice(0,8)}… | ${v.claims[claimIdx].gamesLeft} left`);
    return true;
  }

  return false; // no valid credit found
}

/**
 * Generate a random voucher code.
 */
function generateCode(prefix = 'CELO') {
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${rand}`;
}

module.exports = {
  createVoucher,
  listVouchers,
  redeemVoucher,
  getVoucherBalance,
  useGameCredit,
  generateCode,
};
