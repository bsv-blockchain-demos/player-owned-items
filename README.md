# Monster Battle - BSV Blockchain Game

A Next.js 16 game demonstrating advanced BSV blockchain integration with server-controlled minting, overlay network broadcasting, and on-chain provable item crafting.

---

## 🎯 Project Focus

This project showcases **production-ready BSV blockchain integration** for gaming:

- **Server-Side Minting**: Secure, fraud-proof item creation
- **OrdinalP2PKH Tokens**: BSV-20/BSV-21 compliant token implementation
- **Overlay Network**: Custom overlay for game transactions
- **Material Tokens**: Quantity-based tokens with smart updates
- **Hybrid Crafting**: Client material consumption with server-minted output
- **Auth Outputs**: On-chain provable links between transactions
- **Per-Output Derived Keys**: Type-42 (BRC-42) keys with a per-output nonce + wallet-basket storage (no key reuse)
- **OrderLock Marketplace**: P2P listing / buy / cancel for trading items

**📖 [Read More: Why BSV & Transaction Flow Pattern](./TRANSACTION_FLOW_PATTERN.md)**

---

## 🏗️ Blockchain Architecture

### Server-Side Minting Model

All game items are minted **server-side** for security and validation:

```
Client Request → Server Validates → Server Mints → Server Transfers → Database Update
```

**Why Server-Side?**
- ✅ Single source of truth (server wallet)
- ✅ Prevents fraudulent items
- ✅ Validates user ownership before minting
- ✅ Handles complex SIGHASH scenarios
- ✅ All mints provably originate from server

### Per-Output Derived Keys & Wallet Baskets

Every token output is locked to a unique, freshly-derived child key (type-42 / BRC-42) using a per-output **nonce**, instead of one reused key — improving privacy/linkability and key-exposure hygiene.

- **Protocol**: `TOKEN_PROTOCOL = [2, 'monsterbattle token']` (security level 2, counterparty-bound). Helpers in `src/utils/tokenDerivation.ts`.
- **Nonce storage (dual)**: written to the owner's **wallet basket** via `internalizeAction` (basket `monsterbattle.tokens`) for self-custody/recovery, **and** to a DB index (`tokenId → {keyId, counterparty}`) for O(1) hot-path lookup. The wallet basket is the source of truth; the DB index is a rebuildable cache (`reindexFromBasket`).
- **Creator carries the BEEF**: whoever builds a transfer provides its BEEF (the server holds what it built; clients post base64 BEEF in the request body). The overlay is a fallback only (`fetchTokenSourceTx`). BEEFs cross the wire **base64**-encoded.
- **Dual-path unlock**: the `OrdinalsP2PKH` template defaults to the legacy fixed scheme, so pre-migration tokens still spend; new outputs use the derived scheme.
- **Marketplace**: OrderLock listings are backed up in the `marketplace_listing_beefs` collection so buy/cancel never depend on the overlay.

See the design/plan in `docs/specs/2026-06-11-derived-key-basket-storage-*.md`.

### Three Minting Flows

#### 1. Regular Items (Weapons, Armor, Artifacts)

**Two-Transaction Flow**:
```
Mint TX:     Server → Server (1 sat, OrdinalP2PKH)
Transfer TX: Server → User   (1 sat, OrdinalP2PKH)
```

**API**: `POST /api/items/mint-and-transfer`

**Tracking**:
- `NFTLoot.mintOutpoint` - Server mint proof (txid.vout)
- `UserInventory.tokenId` - User's current outpoint (txid.vout)

#### 2. Material Tokens (Iron, Wood, Dragon Scales)

**Quantity-Based Tokens**:
```
Each material = 1 token with quantity field
Updates reuse same token (no duplication)
```

**Smart Update System**:
- Checks for existing token via `/api/materials/check-token`
- If exists: Updates quantity on existing token
- If new: Mints new token with initial quantity

**API**: `POST /api/materials/mint-and-transfer`

**Tracking**:
- `MaterialToken.mintOutpoint` - Server mint proof
- `MaterialToken.tokenId` - Current outpoint
- `MaterialToken.quantity` - Current material count

#### 3. Crafted Items (Hybrid Flow)

**Most Complex**: Client controls material consumption, server controls item minting.

**Client Transaction**:
```typescript
// useCraftItemNFT.ts
Inputs:  Material tokens (user unlocks)
Outputs: Material change (if excess) + Auth output (locked to server)
```

**Server Transactions**:
```typescript
// /api/crafting/mint-and-transfer
Mint TX:     Auth input → Crafted item (server mints)
Transfer TX: Crafted item → User
```

**Auth Output**:
- Uses `OrdinalP2PKH` (overlay requirement)
- Locked to server public key
- Proves on-chain link: materials → crafted item
- Server validation: "If server can unlock it, it's valid"

**API**: `POST /api/crafting/mint-and-transfer`

**Tracking**:
- `craftingProof.consumptionTxId` - Client material consumption tx
- `craftingProof.authOutpoint` - Auth output linking transactions
- `craftingProof.recipeId` - Recipe used for crafting

---

## 🔗 BSV Blockchain Integration

### OrdinalP2PKH Token Standard

All game tokens use `OrdinalP2PKH` for BSV-20/BSV-21 compliance:

```typescript
import { OrdinalsP2PKH } from '@/utils/ordinalP2PKH';

const ordinalP2PKH = new OrdinalsP2PKH();

// Minting (deploy+mint)
const mintLockingScript = ordinalP2PKH.lock(
  publicKey,
  '',              // Empty assetId for new mint
  metadata,        // Token metadata
  'deploy+mint'
);

// Transferring
const transferLockingScript = ordinalP2PKH.lock(
  userPublicKey,
  assetId,         // mintOutpoint with '.' replaced by '_'
  metadata,
  'transfer'
);

// Unlocking
const unlockTemplate = ordinalP2PKH.unlock(wallet, "single");
const unlockingScript = await unlockTemplate.sign(transaction, outputIndex);
```

**Key Features**:
- OP_FALSE OP_RETURN prefix with JSON metadata
- P2PKH locking for ownership
- Asset ID format: `${mintTxId}_${vout}` (BSV-21 standard)
- SIGHASH_SINGLE for multi-output transactions

### Overlay Network

Custom overlay for broadcasting and querying game transactions:

```typescript
// src/utils/overlayFunctions.ts
import { LookupResolver, TopicBroadcaster } from "@bsv/sdk";

const overlay = new LookupResolver({
  slapTrackers: ['https://overlay-us-1.bsvb.tech'],
  hostOverrides: {
    'ls_monsterbattle': ['https://overlay-us-1.bsvb.tech']
  }
});

// Broadcasting
export const broadcastTX = async (tx: Transaction) => {
  const tb = new TopicBroadcaster(['tm_monsterbattle'], {
    resolver: overlay,
  });
  return await tx.broadcast(tb);
}

// Querying
export async function getTransactionByTxID(txid: string) {
  return await overlay.query({
    service: 'ls_monsterbattle',
    query: { txid: txid }
  }, 10000);
}
```

**Overlay Requirements**:
- All outputs must be `OrdinalP2PKH` or `OrderLock`
- Regular P2PKH outputs are **rejected**
- Includes "helper" outputs like auth tokens

### Transaction Flow Pattern

All blockchain operations in this application follow a **standardized 3-step pattern** for transaction creation and signing:

**📖 [Read Full Documentation: Transaction Flow Pattern](./TRANSACTION_FLOW_PATTERN.md)**

**Quick Summary**:
```
1. createAction  → Prepare transaction with estimated script lengths
2. Sign          → Generate actual unlocking scripts using SDK
3. signAction    → Finalize transaction with actual scripts
```

This pattern provides:
- ✅ **Consistency**: Same flow across all 5 backend routes
- ✅ **BSV-20/21 Support**: Handles fungible (materials) and non-fungible (items) tokens
- ✅ **On-Chain Credibility**: Full provenance for every game item and operation
- ✅ **Server Control**: Prevents fraudulent minting and ensures game rule enforcement
- ✅ **Scalability**: Handles single and multiple input transactions seamlessly

Every item minted, crafted, transferred, or updated has a **verifiable on-chain record**, demonstrating a production-ready blockchain-based game economy.

**Example Routes Using This Pattern**:
- `src/app/api/items/mint-and-transfer/route.ts` - Item NFT minting
- `src/app/api/materials/mint-and-transfer/route.ts` - Material token minting
- `src/app/api/crafting/mint-and-transfer/route.ts` - Crafting with material consumption
- `src/app/api/equipment/update/route.ts` - Equipment inscription updates
- `src/app/api/materials/add-and-merge/route.ts` - Material token merging

### Outpoint Tracking

**Critical**: Always store full outpoints (txid.vout), never just txid.

**Why?**
```
❌ WRONG: transactionId: "abc123..."
   Problem: Which output? Could be vout 0, 1, 2...

✅ CORRECT: tokenId: "abc123...def.0"
   Clear: Exact UTXO location (output 0 of tx abc123...def)
```

**Benefits**:
- Exact UTXO location tracking
- No ambiguity in multi-output transactions
- Correct material token linking
- Easier debugging (paste outpoint in explorer)

**Format**: `${txid}.${vout}`

**Examples**:
```typescript
mintOutpoint:  "abc123...def.0"  // Mint transaction output 0
tokenId:       "ghi789...jkl.0"  // Transfer transaction output 0
authOutpoint:  "mno012...pqr.2"  // Consumption transaction output 2
```

---

## 🛒 OrderLock Marketplace (Coming Soon)

### Architecture Overview

**OrderLock** enables trustless P2P trading using BSV smart contracts:

```
Seller → Creates Order (locks item + price) → Order available on marketplace
Buyer  → Fulfills Order (sends BSV) → Atomic swap (item↔BSV)
```

### Implementation Plan

**Order Creation** _(to be implemented)_:
```typescript
// Future: useCreateOrder.ts
const orderLock = new OrderLock();
const orderScript = orderLock.lock(
  itemOutpoint,      // Item being sold
  priceInSatoshis,   // Asking price
  sellerPublicKey,   // Seller's public key
  payoutPublicKey    // Where seller receives payment
);
```

**Order Fulfillment** _(to be implemented)_:
```typescript
// Future: useFulfillOrder.ts
const unlockScript = orderLock.unlock(
  buyerWallet,
  itemLockingScript,
  priceInSatoshis
);
// Atomic swap: Buyer gets item, seller gets payment
```

### Marketplace Features _(planned)_

- [ ] List minted items for sale (OrderLock)
- [ ] Browse available orders (filter by type/rarity)
- [ ] Purchase items with BSV wallet
- [ ] Cancel orders (seller reclaims item)
- [ ] Order history and trade analytics
- [ ] Escrow-free atomic swaps
- [ ] On-chain price discovery

**Route Structure** _(planned)_:
```
POST /api/marketplace/create-order    - Create OrderLock
POST /api/marketplace/fulfill-order   - Buy item
POST /api/marketplace/cancel-order    - Cancel listing
GET  /api/marketplace/list-orders     - Browse marketplace
```

**Database** _(planned)_:
```typescript
interface MarketplaceOrder {
  _id: ObjectId;
  itemOutpoint: string;        // Item being sold
  sellerUserId: string;        // Seller's userId
  priceInSatoshis: number;     // Asking price
  orderLockOutpoint: string;   // OrderLock UTXO
  status: 'active' | 'fulfilled' | 'cancelled';
  createdAt: Date;
  fulfilledAt?: Date;
  fulfilledBy?: string;        // Buyer's userId
}
```

**References**:
- `src/utils/orderLock.ts` - OrderLock implementation
- `_tests/orderLock.test.ts` - Comprehensive test suite

---

## 🔧 Technology Stack

### Frontend
- **Next.js 16** - App Router, Server Components
- **React 19** - Latest features
- **TypeScript** - Strict mode
- **TailwindCSS v4** - Styling
- **BSV SDK** - Wallet integration (@bsv/sdk)

### Backend
- **Next.js API Routes** - Server-side logic
- **MongoDB** - Database (via native driver)
- **JWT** - Authentication (jose library)
- **BSV Wallet** - Server wallet for minting

### Blockchain
- **BSV Blockchain** - Layer 1
- **OrdinalP2PKH** - Token standard (BSV-20/BSV-21)
- **Overlay Network** - Custom transaction routing
- **OrderLock** - P2P trading smart contracts _(coming soon)_

---

## 📦 Environment Setup

### Required Environment Variables

See .env.example for environment variables.

```bash
# MongoDB
MONGODB_URI=mongodb+srv://...

# Authentication
JWT_SECRET=your-secret-key-minimum-32-chars

# Server Wallet (for minting)
SERVER_WALLET_PRIVATE_KEY=your-server-wallet-private-key-hex
SERVER_WALLET_STORAGE_URL=your-wallet-storage-url
SERVER_WALLET_CHAIN=main-or-test

# Node Environment
NODE_ENV=development
```

### Installation

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Run tests
npm test

# Type checking
npx tsc --noEmit

# Linting
npm run lint
```

---

## 📂 Project Structure

```
src/
├── app/
│   ├── api/                          # API Routes
│   │   ├── items/mint-and-transfer/  # Regular item minting
│   │   ├── materials/mint-and-transfer/ # Material token minting
│   │   ├── crafting/mint-and-transfer/  # Crafted item minting
│   │   └── materials/check-token/    # Material token smart updates
│   ├── battle/                       # Battle page
│   ├── inventory/                    # Inventory page
│   └── crafting/                     # Crafting page
├── components/                       # React components
├── contexts/                         # React Context (Player, Equipment, etc.)
├── hooks/                            # Custom React hooks
│   ├── useMintItemNFT.ts            # Regular item minting hook
│   ├── useMintMaterialTokens.ts     # Material minting hook
│   └── useCraftItemNFT.ts           # Hybrid crafting hook
├── lib/
│   ├── mongodb.ts                   # MongoDB connection
│   ├── serverWallet.ts              # Server wallet utilities
│   ├── types.ts                     # TypeScript interfaces
│   └── loot-table.ts                # Item definitions
├── utils/
│   ├── ordinalP2PKH.ts              # OrdinalP2PKH implementation
│   ├── overlayFunctions.ts          # Overlay broadcast/query
│   ├── orderLock.ts                 # OrderLock smart contract
│   └── jwt.ts                       # JWT utilities
└── _tests/                          # Unit tests
    ├── ordinalP2PKH.test.ts         # Token script tests
    └── orderLock.test.ts            # Marketplace tests

docs/                                 # Documentation
├── SERVER_SIDE_MINTING.md           # Minting architecture
└── [other docs]
```

---

## 🧪 Testing

### Run All Tests
```bash
npm run test
```

### Test Coverage

**OrdinalP2PKH Token Scripts** (`_tests/ordinalP2PKH.test.ts`):
- ✅ Mint transaction creation
- ✅ Transfer transaction creation
- ✅ Script structure validation
- ✅ Metadata encoding/decoding
- ✅ Asset ID format (BSV-21)

**OrderLock Smart Contracts** (`_tests/orderLock.test.ts`):
- ✅ Order creation and locking
- ✅ Order fulfillment (atomic swap)
- ✅ Order cancellation
- ✅ Multi-signature scenarios
- ✅ Edge cases and failure modes

### Integration Testing _(manual)_

**Regular Items**:
1. Mint weapon/armor/artifact
2. Verify `mintOutpoint` in database
3. Verify `tokenId` in UserInventory
4. Check transaction on overlay

**Material Tokens**:
1. Mint new material (e.g., 10 iron)
2. Mint same material again (should update quantity)
3. Verify `mintOutpoint` doesn't change
4. Verify `tokenId` updates to new outpoint
5. Verify quantity = 20

**Crafted Items**:
1. Craft item with exact materials (no change)
2. Craft item with excess materials (check change outputs)
3. Verify auth output on-chain
4. Verify crafting proof in database
5. Verify material quantities updated

---

## 🎮 Game Overview (Brief)

A click-based monster battler where:
- Fight monsters across 5 biomes (Forest → Desert → Ocean → Volcano → Castle)
- Defeat monsters to earn loot (materials, equipment, consumables)
- Craft powerful items using materials
- Equip gear for stat bonuses (damage, crit, defense, HP)
- Level up and progress through tiers (1-5)

**Blockchain Integration**:
- All items/materials are BSV blockchain tokens
- Crafting creates provable on-chain links
- Future: Trade items on P2P marketplace (OrderLock)

---

## 🔐 Security Features

### Server-Side Validation
- User ownership verified before minting
- JWT authentication on all API routes
- MongoDB queries filtered by userId

### Anti-Cheat System
- Server-side time tracking (database timestamps)
- Click rate validation (max 15 clicks/sec)
- HP verification (did player survive monster damage?)

### Blockchain Security
- Server wallet private key secured in environment
- All mints provably from server wallet (mintOutpoint)
- Auth outputs prove material consumption for crafting
- Outpoint tracking prevents UTXO confusion


## 🤝 Contributing

### Development Workflow

1. Create feature branch: `git checkout -b feature/my-feature`
2. Make changes (ensure TypeScript compiles: `npx tsc --noEmit`)
3. Run tests: `npm run test`
4. Commit with clear message
5. Push and create PR

## 📝 License

MIT

---

**Built with BSV Blockchain and Next.js**
