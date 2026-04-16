/**
 * blockchain/celoConnector.js
 *
 * Bridges the game engine ↔ PokerEscrow smart contract.
 *
 * Responsibilities:
 *   - Watch for joinTable events on-chain (player buy-in confirmed)
 *   - Call startGame() on contract when engine starts
 *   - Call declarePayout() + batchPayout() when hand session ends
 *   - Call cancelTable() + batchRefund() if lobby times out
 *   - Read on-chain player balances to issue correct chip counts
 *
 * The operator private key signs all contract calls.
 * Players only need to approve() + the contract pulls their cUSD.
 */

const { ethers } = require('ethers');

// Minimal ABI — only the functions we call from the backend
const POKER_ESCROW_ABI = [
  // Write
  'function createTable(uint256 minBuyIn, uint256 maxBuyIn) returns (uint256)',
  'function startGame(uint256 tableId)',
  'function declarePayout(uint256 tableId, address[] winners, uint256[] grossAmounts)',
  'function batchPayout(uint256 tableId)',
  'function cancelTable(uint256 tableId)',
  'function batchRefund(uint256 tableId)',
  'function withdrawHouseFees(address to, uint256 amount)',
  // Read
  'function getTable(uint256 tableId) view returns (uint8 state, uint256 minBuyIn, uint256 maxBuyIn, uint256 totalPot, uint256 playerCount, uint256 createdAt, uint256 startedAt)',
  'function getPlayers(uint256 tableId) view returns (tuple(address addr, uint256 buyIn, uint256 winnings, bool claimed)[])',
  'function isPlayerAtTable(uint256 tableId, address player) view returns (bool)',
  'function tableCount() view returns (uint256)',
  'function totalHouseFees() view returns (uint256)',
  // Events
  'event TableCreated(uint256 indexed tableId, uint256 minBuyIn, uint256 maxBuyIn)',
  'event PlayerJoined(uint256 indexed tableId, address indexed player, uint256 amount)',
  'event GameStarted(uint256 indexed tableId, uint256 playerCount, uint256 totalPot)',
  'event PayoutDeclared(uint256 indexed tableId, address[] winners, uint256[] amounts, uint256 houseFee)',
  'event TableCancelled(uint256 indexed tableId)',
];

// cUSD ABI (just what we need)
const CUSD_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

class CeloConnector {
  /**
   * @param {object} config
   * @param {string} config.rpcUrl             — Celo RPC endpoint
   * @param {string} config.operatorPrivateKey  — Backend hot wallet key
   * @param {string} config.contractAddress     — PokerEscrow deployed address
   * @param {string} config.cusdAddress         — cUSD token address
   * @param {string} [config.houseAddress]      — Where to send house fees
   * @param {boolean} [config.dryRun=false]     — Log calls but don't broadcast
   */
  constructor(config) {
    this.dryRun  = config.dryRun ?? false;

    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet   = new ethers.Wallet(config.operatorPrivateKey, this.provider);

    this.contract = new ethers.Contract(
      config.contractAddress,
      POKER_ESCROW_ABI,
      this.wallet,
    );

    this.cusd = new ethers.Contract(
      config.cusdAddress,
      CUSD_ABI,
      this.provider,
    );

    this.houseAddress = config.houseAddress ?? this.wallet.address;

    // tableId mapping: offchain UUID → on-chain uint256
    this.tableIdMap = new Map(); // offchainId → onChainId
    this.onChainToOffchain = new Map();

    console.log(`[CeloConnector] Operator: ${this.wallet.address}`);
    console.log(`[CeloConnector] Contract: ${config.contractAddress}`);
    console.log(`[CeloConnector] DryRun  : ${this.dryRun}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  TABLE LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create a table on-chain. Called when a lobby is opened.
   * @returns {Promise<string>} on-chain tableId (uint256 as string)
   */
  async createOnChainTable(offchainTableId, minBuyInUSD, maxBuyInUSD = 0) {
    const minBuyIn = ethers.parseUnits(String(minBuyInUSD), 18);
    const maxBuyIn = maxBuyInUSD ? ethers.parseUnits(String(maxBuyInUSD), 18) : 0n;

    if (this.dryRun) {
      const fakeId = String(this.tableIdMap.size + 1);
      this.tableIdMap.set(offchainTableId, fakeId);
      this.onChainToOffchain.set(fakeId, offchainTableId);
      console.log(`[DryRun] createTable(${minBuyInUSD}, ${maxBuyInUSD}) → fake id ${fakeId}`);
      return fakeId;
    }

    const tx       = await this.contract.createTable(minBuyIn, maxBuyIn);
    const receipt  = await tx.wait();

    // Extract tableId from event
    const event    = receipt.logs
      .map(log => { try { return this.contract.interface.parseLog(log); } catch { return null; } })
      .find(e => e?.name === 'TableCreated');

    const onChainId = event?.args?.tableId?.toString() ?? await this.contract.tableCount();

    this.tableIdMap.set(offchainTableId, String(onChainId));
    this.onChainToOffchain.set(String(onChainId), offchainTableId);

    console.log(`[Chain] Table created: off=${offchainTableId.slice(0,8)} on=${onChainId} tx=${receipt.hash}`);
    return String(onChainId);
  }

  /**
   * Called by the backend when countdown expires and game starts.
   */
  async onChainStartGame(offchainTableId) {
    const onChainId = this._requireOnChainId(offchainTableId);

    if (this.dryRun) {
      console.log(`[DryRun] startGame(${onChainId})`);
      return;
    }

    const tx      = await this.contract.startGame(onChainId);
    const receipt = await tx.wait();
    console.log(`[Chain] Game started: table=${onChainId} tx=${receipt.hash}`);
  }

  /**
   * Declare payouts after the game session finishes.
   *
   * @param {string}   offchainTableId
   * @param {object[]} payouts  — [{ address, grossAmountUSD }]
   *   grossAmountUSD is BEFORE house fee (contract takes 10% on-chain)
   *
   * The backend calculates gross from chip counts:
   *   grossUSD = finalChips / CHIPS_PER_DOLLAR
   */
  async onChainDeclarePayout(offchainTableId, payouts) {
    const onChainId = this._requireOnChainId(offchainTableId);

    // Read on-chain total pot to cross-check
    const [, , , totalPotWei] = await this.contract.getTable(onChainId);
    const totalPot = totalPotWei; // BigInt in wei (18 decimals)

    // Build parallel arrays
    // We sum contributions to match totalPot exactly
    // payouts = [{ address, grossAmountUSD }]
    const winners  = payouts.map(p => p.address);
    const amounts  = payouts.map(p => ethers.parseUnits(
      Number(p.grossAmountUSD).toFixed(18), 18
    ));

    // Sanity: amounts must sum to totalPot
    const sumAmounts = amounts.reduce((s, a) => s + a, 0n);
    if (sumAmounts !== totalPot) {
      // Adjust last entry to make it exact (rounding errors)
      amounts[amounts.length - 1] += totalPot - sumAmounts;
    }

    if (this.dryRun) {
      console.log(`[DryRun] declarePayout(${onChainId})`, { winners, amounts: amounts.map(String) });
      return;
    }

    const tx      = await this.contract.declarePayout(onChainId, winners, amounts);
    const receipt = await tx.wait();
    console.log(`[Chain] Payout declared: table=${onChainId} tx=${receipt.hash}`);

    // Then batch-pay everyone
    const tx2      = await this.contract.batchPayout(onChainId);
    const receipt2 = await tx2.wait();
    console.log(`[Chain] Batch paid: table=${onChainId} tx=${receipt2.hash}`);
  }

  /**
   * Cancel table and refund all players (e.g. lobby never reached 3 players).
   */
  async onChainCancelTable(offchainTableId) {
    const onChainId = this._requireOnChainId(offchainTableId);

    if (this.dryRun) {
      console.log(`[DryRun] cancelTable(${onChainId}) + batchRefund`);
      return;
    }

    const tx      = await this.contract.cancelTable(onChainId);
    await tx.wait();
    const tx2     = await this.contract.batchRefund(onChainId);
    const receipt = await tx2.wait();
    console.log(`[Chain] Table cancelled + refunded: ${onChainId} tx=${receipt.hash}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  EVENT LISTENING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Start listening for PlayerJoined events.
   * When a player pays on-chain, confirm their seat in the off-chain engine.
   *
   * @param {function} onPlayerJoined ({ onChainTableId, address, amountUSD })
   */
  listenForJoins(onPlayerJoined) {
    this.contract.on('PlayerJoined', (tableId, player, amount) => {
      const amountUSD = Number(ethers.formatUnits(amount, 18));
      const onChainId = tableId.toString();
      const offchainId = this.onChainToOffchain.get(onChainId);
      console.log(`[Event] PlayerJoined table=${onChainId} addr=${player} amount=$${amountUSD.toFixed(2)}`);
      onPlayerJoined({ onChainTableId: onChainId, offchainTableId: offchainId, address: player, amountUSD });
    });
  }

  /**
   * Stop all event listeners.
   */
  stopListening() {
    this.contract.removeAllListeners();
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  READ HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  async getTableOnChain(offchainTableId) {
    const onChainId = this._requireOnChainId(offchainTableId);
    const [state, minBuyIn, maxBuyIn, totalPot, playerCount, createdAt, startedAt] =
      await this.contract.getTable(onChainId);
    return {
      state: ['WAITING', 'ACTIVE', 'FINISHED', 'CANCELLED'][state],
      minBuyInUSD:   Number(ethers.formatUnits(minBuyIn, 18)),
      maxBuyInUSD:   Number(ethers.formatUnits(maxBuyIn, 18)),
      totalPotUSD:   Number(ethers.formatUnits(totalPot, 18)),
      playerCount:   Number(playerCount),
      createdAt:     Number(createdAt),
      startedAt:     Number(startedAt),
    };
  }

  async getPlayerBuyIn(offchainTableId, playerAddress) {
    const onChainId = this._requireOnChainId(offchainTableId);
    const players   = await this.contract.getPlayers(onChainId);
    const slot      = players.find(p => p.addr.toLowerCase() === playerAddress.toLowerCase());
    if (!slot) return 0;
    return Number(ethers.formatUnits(slot.buyIn, 18));
  }

  async getCUSDBalance(address) {
    const bal = await this.cusd.balanceOf(address);
    return Number(ethers.formatUnits(bal, 18));
  }

  async getTotalHouseFees() {
    const fees = await this.contract.totalHouseFees();
    return Number(ethers.formatUnits(fees, 18));
  }

  async withdrawHouseFees(toAddress) {
    const fees = await this.contract.totalHouseFees();
    if (fees === 0n) return;
    if (this.dryRun) { console.log(`[DryRun] withdrawHouseFees($${ethers.formatUnits(fees, 18)})`); return; }
    const tx = await this.contract.withdrawHouseFees(toAddress ?? this.houseAddress, fees);
    await tx.wait();
    console.log(`[Chain] House fees withdrawn: $${ethers.formatUnits(fees, 18)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  CHIP ↔ USD CONVERSION (matches TableManager)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Convert final chip counts back to gross USD amounts for contract payout.
   *
   * @param {object[]} players     — [{ address, finalChips, initialChips }]
   * @param {number}   chipsPerUSD — 100 (default: 1 chip = $0.01)
   * @returns {object[]} [{ address, grossAmountUSD }]
   */
  buildPayoutList(players, chipsPerUSD = 100) {
    // Total buy-in (USD) = sum of (initialChips / chipsPerUSD) for all players
    const totalBuyInUSD = players.reduce((s, p) => s + p.initialChips / chipsPerUSD, 0);

    // Gross = proportional share of total pot
    // But simpler: just use finalChips as the gross amounts — the contract enforces the 90/10 split
    // grossAmountUSD[i] = finalChips[i] / chipsPerUSD
    // But we need sum(gross) == totalPot → use initial buy-ins as gross (the engine re-distributes chips)

    // For a game where: totalPot = sum(buyIns), winner gets all chips
    // finalChips represent the post-engine distribution
    // We pass finalChips/chipsPerUSD as grossAmounts and let the contract take its 10%

    const list = players.map(p => ({
      address:       p.address,
      grossAmountUSD: p.finalChips / chipsPerUSD,
    }));

    // Normalize: gross amounts must sum to totalBuyInUSD exactly
    const grossSum = list.reduce((s, p) => s + p.grossAmountUSD, 0);
    if (Math.abs(grossSum - totalBuyInUSD) > 0.001) {
      // Scale proportionally
      const scale = totalBuyInUSD / grossSum;
      list.forEach(p => { p.grossAmountUSD *= scale; });
    }

    return list;
  }

  // ─── Private ─────────────────────────────────────────────────────────────
  _requireOnChainId(offchainTableId) {
    const id = this.tableIdMap.get(offchainTableId);
    if (!id) throw new Error(`No on-chain ID for table ${offchainTableId}`);
    return id;
  }
}

/**
 * Factory: create connector from environment variables.
 */
function createConnector(overrides = {}) {
  const network = process.env.CELO_NETWORK || 'alfajores';

  const RPC_URLS = {
    celo:      'https://forno.celo.org',
    alfajores: 'https://alfajores-forno.celo-testnet.org',
    local:     'http://127.0.0.1:8545',
  };

  const CUSD_ADDRESSES = {
    celo:      '0x765DE816845861e75A25fCA122bb6898B8B1282a',
    alfajores: '0x874069Fa1Eb16D44d622F2e0Ca25eeA172369bC1',
    local:     process.env.MOCK_CUSD_ADDRESS || '',
  };

  return new CeloConnector({
    rpcUrl:            overrides.rpcUrl      || RPC_URLS[network],
    operatorPrivateKey: overrides.operatorKey || process.env.OPERATOR_KEY || '',
    contractAddress:   overrides.contract    || process.env.POKER_ESCROW_ADDRESS || '',
    cusdAddress:       overrides.cusd        || CUSD_ADDRESSES[network],
    houseAddress:      overrides.house       || process.env.HOUSE_ADDRESS,
    dryRun:            overrides.dryRun      ?? (process.env.DRY_RUN === 'true'),
    ...overrides,
  });
}

module.exports = { CeloConnector, createConnector };
