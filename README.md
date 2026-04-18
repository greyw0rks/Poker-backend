# CeloPoker — Backend

No-Limit Texas Hold'em game server powering CeloPoker. Built with Node.js, Express, and Socket.io.

## Stack

- **Runtime:** Node.js 20+
- **Framework:** Express + Socket.io
- **Blockchain:** Celo Mainnet via ethers.js v6
- **Contract:** PokerEscrow.sol at `0x4EdB68a7EE036D7438f6E8fcBE43b35539e55Ec3`
- **Token:** cUSD `0x765DE816845861e75A25fCA122bb6898B8B1282a`

## Quick Start

```bash
npm install
cp .env.example .env   # fill in your keys
npm start              # starts on PORT (default 8080)
```

## Environment Variables

```env
PORT=8080
NODE_ENV=production

# Blockchain
CELO_NETWORK=celo
POKER_ESCROW_ADDRESS=0x4EdB68a7EE036D7438f6E8fcBE43b35539e55Ec3
CUSD_ADDRESS=0x765DE816845861e75A25fCA122bb6898B8B1282a
OPERATOR_KEY=0xYOUR_OPERATOR_PRIVATE_KEY
OPERATOR_ADDRESS=0xYOUR_OPERATOR_ADDRESS
HOUSE_ADDRESS=0xYOUR_HOUSE_ADDRESS

# Admin
ADMIN_SECRET=celopoker_admin
```

## API Reference

### Health
```
GET /health
```

### Tables
```
GET  /tables              — list open tables
GET  /tables/:id          — get table state
```

### Difficulty Rooms (vs Bots)
```
POST /rooms/create        — create a difficulty room
  body: { hostName, difficulty: easy|normal|hard|super|private, address }
  returns: { tableId, code, humanPlayerId, buyInUSD }

GET  /rooms/:code         — join by 6-char invite code
GET  /rooms               — list open rooms
```

| Difficulty | Buy-in | Bots |
|------------|--------|------|
| easy       | $0.10  | 3 casual |
| normal     | $0.15  | 3 smart |
| hard       | $0.50  | 3 aggressive |
| super      | $1.00  | 3 GTO |
| private    | $0.20  | 0 (friends only) |

### Vouchers
```
POST /vouchers/redeem           — { code, address }
GET  /vouchers/balance/:address — check games left

POST /admin/vouchers            — create voucher (requires secret)
  body: { secret, code, gamesPerClaim, maxClaims, buyInPerGame, daysValid }
GET  /admin/vouchers?secret=    — list all vouchers
DELETE /admin/vouchers/:code?secret= — deactivate
```

### Stats & Leaderboard
```
GET /leaderboard          — top 10 players by USD won
GET /stats/:address       — individual player stats
```

### Dev Mode
```
POST /dev/human-bot-table — create human vs bots table (DEV_MODE only)
  body: { humanName, botCount, minBuyInUSD }
```

## Socket.io Events

### Client → Server
| Event | Payload |
|-------|---------|
| `join_table` | `{ tableId, name, address, buyInUSD, humanPlayerId? }` |
| `action` | `{ tableId, type: fold\|check\|call\|raise\|allin, amount? }` |
| `get_state` | `{ tableId }` |
| `get_cards` | `{ tableId }` |

### Server → Client
| Event | Description |
|-------|-------------|
| `connected` | Socket connected |
| `join_ok` | Joined successfully — includes `playerIdx` (your seat) |
| `game_state` | Full table state update |
| `hand_started` | New hand began |
| `hole_cards` | Your 2 private cards `{ cards: ['As', 'Kd'] }` |
| `street_dealt` | Flop/Turn/River dealt |
| `player_action` | A player acted |
| `hand_complete` | Hand finished with winner + payouts |
| `table_finished` | All hands done, final results |
| `error` | Something went wrong |

## Architecture

```
server/
  index.js          — Express app + Socket.io + all routes
  tableManager.js   — Table lifecycle, lobby timers, game state
  voucherManager.js — Voucher codes (JSON file storage)
  winningsManager.js — Player stats + leaderboard (JSON file storage)

engine/
  gameEngine.js     — NLHE state machine (PREFLOP→FLOP→TURN→RIVER→SHOWDOWN)
  handEvaluator.js  — 7-card best hand evaluator
  deck.js           — 52-card deck + Fisher-Yates shuffle
  potManager.js     — Side pot calculator for all-in scenarios

bots/
  botPlayer.js      — 5 bot strategies: RANDOM, CALL_STATION, FOLDER, AGGRESSIVE, GTO_BASIC

data/               — Persistent JSON files (vouchers, balances, winnings)
```

## Game Rules

- **Players:** 3–6 per table
- **Timer:** 1 minute lobby, 30 seconds per action
- **Payout:** 90% to winner, 10% house fee
- **Blockchain:** All payouts executed on-chain via `batchPayout()`

## Deploying to Railway

1. Connect this repo to Railway
2. Set all environment variables listed above
3. Railway auto-detects Node.js and runs `npm start`
4. Set `PORT=8080` in Railway variables

## Admin: Creating Vouchers


