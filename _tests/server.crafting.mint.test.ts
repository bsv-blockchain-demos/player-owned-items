// Bypass real auth (covered by the scaffold's requireAuthProof tests) — inject userId.
jest.mock('@server/middleware/requireAuthProof', () => ({
  requireAuthProof: () => (req: any, _res: any, next: any) => { req.userId = 'u1'; next(); },
}));

const enqueue = jest.fn((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
const getWalletQueue = jest.fn(async () => ({ enqueue }));
jest.mock('@server/lib/walletQueue', () => ({ getWalletQueue: () => getWalletQueue() }));

const nftInsertOne = jest.fn(async () => ({ insertedId: 'NFT_OID' }));
const inventoryInsertOne = jest.fn(async () => ({ insertedId: 'INV_OID' }));
const materialDeleteOne = jest.fn(async (_filter: any) => ({ deletedCount: 1 }));
const materialUpdateOne = jest.fn(async (_filter: any, _update: any) => ({ modifiedCount: 1 }));
// Token claim (and release) — by default every token in the $or claims successfully.
const materialUpdateMany = jest.fn(async (filter: any, _update: any) => ({ modifiedCount: filter.$or?.length ?? 0 }));
// Server-trusted material tokens keyed by DB id — the DB, not the body, owns quantity.
type OwnedToken = { lootTableId: string; tokenId: string; quantity: number; tier: number; mintOutpoint?: string };
let ownedTokens: Record<string, OwnedToken> = {};
const materialFindOne = jest.fn(async (q: { _id: { toHexString(): string }; userId: string; lootTableId: string }) => {
  const t = ownedTokens[q._id.toHexString()];
  return t && q.userId === 'u1' && t.lootTableId === q.lootTableId ? { _id: q._id, ...t } : null;
});
const listingFindOne = jest.fn(async (_filter: any): Promise<unknown> => null);
// Minted item NFTs (artifact recipe inputs) keyed by inventory id.
type OwnedItem = { lootTableId: string; tokenId: string; mintOutpoint?: string };
let ownedItems: Record<string, OwnedItem> = {};
const inventoryFindOne = jest.fn(async (q: any) => {
  const t = ownedItems[q._id.toHexString()];
  return t && q.userId === 'u1' && t.lootTableId === q.lootTableId ? { _id: q._id, nftLootId: new ObjectId(), ...t } : null;
});
const inventoryDeleteOne = jest.fn(async (_filter: any) => ({ deletedCount: 1 }));
const inventoryUpdateMany = jest.fn(async (filter: any, _update: any) => ({ modifiedCount: filter.$or?.length ?? 0 }));
let playerLevel = 1;
let equippedItems: Record<string, unknown> = {};
const playerStatsFindOne = jest.fn(async () => ({ userId: 'u1', level: playerLevel, equippedItems }));
const playerStatsUpdateOne = jest.fn(async (_filter: any, _update: any) => ({ modifiedCount: 0 }));
jest.mock('@server/lib/mongodb', () => ({
  connectToMongo: jest.fn(async () => ({
    userInventoryCollection: {
      insertOne: inventoryInsertOne,
      findOne: inventoryFindOne,
      deleteOne: inventoryDeleteOne,
      updateMany: inventoryUpdateMany,
    },
    nftLootCollection: { insertOne: nftInsertOne },
    materialTokensCollection: {
      findOne: materialFindOne,
      deleteOne: materialDeleteOne,
      updateOne: materialUpdateOne,
      updateMany: materialUpdateMany,
    },
    playerStatsCollection: { findOne: playerStatsFindOne, updateOne: playerStatsUpdateOne },
    marketplaceItemsCollection: { findOne: listingFindOne },
  })),
}));

// Pre-lock reads use the SAME singleton wallet the queue serializes over — mock
// getServerWallet() to resolve to the exact stubWallet passed into enqueue.
jest.mock('@server/lib/serverWallet', () => ({
  getServerWallet: jest.fn(async () => stubWallet),
  getServerPublicKey: jest.fn(async () => 'LEGACY_PK'),
  getServerIdentityPublicKey: jest.fn(async () => 'SERVER_ID'),
}));

// broadcastTX is now fire-and-forget off-path (txids are derived locally, not from
// its return value) — default to a resolving promise so `.catch()` on the call site
// never throws synchronously on an undefined return.
jest.mock('@shared/overlayFunctions', () => ({ broadcastTX: jest.fn(async () => ({ txid: 'OVERLAY_TXID' })) }));
jest.mock('@shared/beefEncoding', () => ({ decodeBeef: jest.fn(() => [1, 2, 3]), encodeBeef: jest.fn(() => 'BEEF_B64') }));

let nonceQueue: string[] = [];
jest.mock('@shared/tokenDerivation', () => ({
  TOKEN_PROTOCOL: [2, 'monsterbattle token'],
  generateNonce: jest.fn(() => nonceQueue.shift() ?? 'NONCE_FALLBACK'),
  deriveRecipientKey: jest.fn(async () => 'USERKEY'),
  deriveSelfKey: jest.fn(async () => 'MINTKEY'),
}));
// The "hex" is the inscription the route asked for, so a test can rebuild the tx it made.
const ordLock = jest.fn((...args: unknown[]) => ({ toHex: () => JSON.stringify({ op: args[3], amt: args[4], id: args[1] || undefined }) }));
jest.mock('@shared/ordinalP2PKH', () => ({
  OrdinalsP2PKH: class {
    lock(...args: unknown[]) { return ordLock(...args); }
    unlock() { return { estimateLength: async () => 100 }; }
  },
}));
jest.mock('@bsv/wallet-helper', () => ({ WalletP2PKH: class { unlock() { return { estimateLength: async () => 100 }; } } }));
jest.mock('@bsv/sdk', () => ({
  Transaction: {
    fromBEEF: jest.fn(),
    fromAtomicBEEF: jest.fn(() => ({})),
  },
  P2PKH: class { lock() { return { toHex: () => 'PS' }; } },
  Beef: class { mergeBeef() {} toBinary() { return []; } toBEEF() { return []; } },
  Hash: { hash160: () => 'H' },
}));

import request from 'supertest';
import { inscribedScript, tokenInput, sourceOutput } from './helpers/ordinalScript';
import { ObjectId } from 'mongodb';
import { buildApp } from '@server/app';
import { Transaction } from '@bsv/sdk';
import { broadcastTX } from '@shared/overlayFunctions';
import { publicKeyToGradient } from '@shared/publicKeyToColor';

const stubWallet = {
  createAction: jest.fn(),
  signAction: jest.fn(),
  getPublicKey: jest.fn(async () => ({ publicKey: 'PK' })),
};

const WOOD = '64b000000000000000000001';
const LEATHER = '64b000000000000000000002';
const WOOD_T3 = '64b000000000000000000003';
const STEEL = '64b000000000000000000004';

// craft_wooden_sword: 5 common_wood + 2 common_leather -> common_dagger (tier 1).
// outputItem and per-material quantity/metadata are FORGED to prove the server ignores them.
const validBody = {
  recipeId: 'craft_wooden_sword',
  transferredMaterials: [
    { lootTableId: 'common_wood', tokenId: 'BATCHTX.0', materialTokenId: WOOD, quantity: 1000, quantityNeeded: 1, itemName: 'Forged', rarity: 'legendary', tier: 5 },
    { lootTableId: 'common_leather', tokenId: 'BATCHTX.1', materialTokenId: LEATHER, quantity: 1000, quantityNeeded: 1, itemName: 'Forged', rarity: 'legendary', tier: 5 },
  ],
  outputItem: {
    lootTableId: 'excalibur',
    name: 'Excalibur',
    rarity: 'legendary',
    type: 'weapon',
    tier: 5,
    equipmentStats: { damageBonus: 9999 },
    crafted: { statRoll: 1.2 },
    borderGradient: { color1: 'a', color2: 'b' },
  },
  userIdentityKey: 'USER_ID_KEY',
  paymentTx: 'PAYMENT_B64',
  batchTransferBeef: 'BATCH_B64',
  transferNonce: 'N2',
  walletParams: { protocolID: [0, 'x'], keyID: '1', counterparty: 'cp' },
};

const defaultOwnedTokens = (): Record<string, OwnedToken> => ({
  [WOOD]: { lootTableId: 'common_wood', tokenId: 'WOODTX.0', quantity: 7, tier: 1, mintOutpoint: 'WOODMINT.0' },
  [LEATHER]: { lootTableId: 'common_leather', tokenId: 'LEATHERTX.0', quantity: 2, tier: 1, mintOutpoint: 'LEATHERMINT.0' },
  [WOOD_T3]: { lootTableId: 'common_wood', tokenId: 'WOODT3TX.0', quantity: 4, tier: 3, mintOutpoint: 'WOODT3MINT.0' },
});
const defaultBatchInputs = [
  tokenInput('WOODTX', 0, { op: 'transfer', amt: 7, id: 'WOODMINT_0' }),
  tokenInput('LEATHERTX', 0, { op: 'transfer', amt: 2, id: 'LEATHERMINT_0' }),
];

const inscribed = (hex: string, amt: number, lootTableId: string, assetId: string) => inscribedScript(hex, amt, { lootTableId }, assetId);

/** payment tx + batch-transfer tx — reached by every request past field validation. */
function seedPaymentAndBatchMocks(
  scriptHexes: string[],
  inputs: unknown[] = defaultBatchInputs,
  amts = [7, 2],
  lootIds = ['common_wood', 'common_leather'],
  assetIds = ['WOODMINT_0', 'LEATHERMINT_0'],
) {
  (Transaction.fromBEEF as jest.Mock)
    .mockReturnValueOnce({ id: () => 'PAYTXID', outputs: [{ satoshis: 100 }] })
    .mockReturnValueOnce({
      id: () => 'BATCHTX',
      inputs,
      outputs: scriptHexes.map((hex, i) => ({ lockingScript: inscribed(hex, amts[i], lootIds[i], assetIds[i]) })),
      toBEEF: () => [1, 1],
    });
}

/** Nothing was claimed or sent to the wallet. */
function expectNotClaimed() {
  expect(materialUpdateMany).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
}

/** The two dependent wallet actions inside the queue (mint crafted item, then transfer). */
function seedEnqueueMocks(materialInputCount = 2, nonces = ['N_MINT', 'N_ITEM', 'N_CHANGE'], walletFundingInputs = 0) {
  (Transaction.fromBEEF as jest.Mock)
    .mockReturnValueOnce({ inputs: [{ unlockingScript: { toHex: () => 'MINTUNLOCK' } }], sign: async () => {} }) // craftedItemTxToSign
    .mockReturnValueOnce({
      inputs: [
        ...Array.from({ length: materialInputCount + 1 }, (_, i) => ({ unlockingScript: { toHex: () => `U${i}` } })),
        // Funding inputs the wallet appends when the 1-sat inputs can't pay the fee: no template, the wallet signs them.
        ...Array.from({ length: walletFundingInputs }, () => ({})),
      ],
      sign: async () => {},
    }); // txToSign (materials + crafted item [+ wallet funding])

  // Both txids are derived locally via .id('hex') on the fromAtomicBEEF result. The two
  // mockReturnValueOnce calls cover the calls made INSIDE enqueue (mint then transfer);
  // the mockReturnValue fallback covers the off-path re-decodes fired after the response.
  (Transaction.fromAtomicBEEF as jest.Mock)
    .mockReturnValueOnce({ id: () => 'MINTTX', toBEEF: () => [2, 2] }) // craftedItemTx (inside enqueue)
    .mockReturnValueOnce({ id: () => 'TRANSFERTX' }) // transferTx (inside enqueue)
    .mockReturnValue({ id: () => 'TRANSFERTX' }); // off-path broadcasts after response

  stubWallet.createAction
    .mockResolvedValueOnce({ signableTransaction: { reference: 'REF1', tx: [7, 7] } }) // mint
    .mockResolvedValueOnce({ signableTransaction: { reference: 'REF2', tx: [8, 8] } }); // transfer
  stubWallet.signAction
    .mockResolvedValueOnce({ tx: Uint8Array.from([9, 9]) }) // mint
    .mockResolvedValueOnce({ tx: Uint8Array.from([11, 11]) }); // transfer

  nonceQueue = nonces; // mintNonce, itemNonce, then one per change output
}

/** The claim id the route stamped on the material tokens (first updateMany call). */
const tokenClaimId = () => materialUpdateMany.mock.calls[0][1].$set.pendingClaim as string;

const post = (body: unknown) => request(buildApp()).post('/api/crafting/mint-and-transfer').send(body as object);

describe('POST /api/crafting/mint-and-transfer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Transaction as any).fromBEEF = jest.fn();
    (Transaction as any).fromAtomicBEEF = jest.fn(() => ({}));
    nftInsertOne.mockResolvedValue({ insertedId: 'NFT_OID' });
    inventoryInsertOne.mockResolvedValue({ insertedId: 'INV_OID' });
    materialDeleteOne.mockResolvedValue({ deletedCount: 1 });
    materialUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    materialUpdateMany.mockImplementation(async (filter: any) => ({ modifiedCount: filter.$or?.length ?? 0 }));
    enqueue.mockImplementation((_label: string, fn: (w: any) => Promise<any>) => fn(stubWallet));
    getWalletQueue.mockImplementation(async () => ({ enqueue }));
    listingFindOne.mockResolvedValue(null);
    stubWallet.getPublicKey.mockResolvedValue({ publicKey: 'PK' });
    nonceQueue = [];
    ownedTokens = defaultOwnedTokens();
    playerLevel = 1;
    ownedItems = {};
    equippedItems = {};
    inventoryDeleteOne.mockResolvedValue({ deletedCount: 1 });
    inventoryUpdateMany.mockImplementation(async (filter: any) => ({ modifiedCount: filter.$or?.length ?? 0 }));
  });

  afterEach(() => jest.restoreAllMocks());

  it('400 on missing transferredMaterials', async () => {
    const res = await post({ ...validBody, transferredMaterials: [] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing or invalid transferredMaterials' });
    expectNotClaimed();
  });

  it('400 on missing userIdentityKey', async () => {
    const res = await post({ ...validBody, userIdentityKey: undefined });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields' });
    expectNotClaimed();
  });

  it('400 on missing paymentTx', async () => {
    const res = await post({ ...validBody, paymentTx: undefined });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing payment transaction' });
    expectNotClaimed();
  });

  it('400 on missing batchTransferBeef', async () => {
    const res = await post({ ...validBody, batchTransferBeef: undefined });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing batch transfer BEEF' });
    expectNotClaimed();
  });

  it('400 on missing walletParams', async () => {
    const res = await post({ ...validBody, walletParams: undefined });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing wallet derivation parameters' });
    expectNotClaimed();
  });

  it('400 on an unknown recipeId', async () => {
    const res = await post({ ...validBody, recipeId: 'craft_free_excalibur' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Unknown recipe: craft_free_excalibur' });
    expectNotClaimed();
  });

  it.each([
    ['the same material token twice', [validBody.transferredMaterials[0], validBody.transferredMaterials[1], { ...validBody.transferredMaterials[0], tokenId: 'BATCHTX.2' }]],
    ['the same material token twice in different case', [validBody.transferredMaterials[0], validBody.transferredMaterials[1], { ...validBody.transferredMaterials[0], tokenId: 'BATCHTX.2', materialTokenId: WOOD.toUpperCase() }]],
    ['the same batch outpoint twice', [validBody.transferredMaterials[0], { ...validBody.transferredMaterials[1], tokenId: 'BATCHTX.0' }]],
    ['a malformed materialTokenId', [validBody.transferredMaterials[0], { ...validBody.transferredMaterials[1], materialTokenId: { $ne: null } }]],
    ['a non-string tokenId', [validBody.transferredMaterials[0], { ...validBody.transferredMaterials[1], tokenId: 7 }]],
  ])('400 when the transfer lists %s', async (_label, transferredMaterials) => {
    const res = await post({ ...validBody, transferredMaterials });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid transferredMaterials' });
    expectNotClaimed();
  });

  it('400 when a required material is missing from the transfer', async () => {
    const res = await post({ ...validBody, transferredMaterials: [validBody.transferredMaterials[0]] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Transferred materials do not match recipe craft_wooden_sword' });
    expectNotClaimed();
  });

  it('400 when a material outside the recipe is transferred', async () => {
    const res = await post({
      ...validBody,
      transferredMaterials: [...validBody.transferredMaterials, { lootTableId: 'rare_steel', tokenId: 'BATCHTX.2', materialTokenId: STEEL }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Transferred materials do not match recipe craft_wooden_sword' });
    expectNotClaimed();
  });

  it('403 when the player is below the recipe unlock level', async () => {
    playerLevel = 2; // craft_iron_sword unlocks at level 3
    const res = await post({
      ...validBody,
      recipeId: 'craft_iron_sword',
      transferredMaterials: [
        { lootTableId: 'rare_steel', tokenId: 'BATCHTX.0', materialTokenId: STEEL },
        { lootTableId: 'common_wood', tokenId: 'BATCHTX.1', materialTokenId: WOOD },
        { lootTableId: 'common_leather', tokenId: 'BATCHTX.2', materialTokenId: LEATHER },
      ],
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Recipe craft_iron_sword requires level 3' });
    expectNotClaimed();
  });

  it('400 when the user does not own the named material token', async () => {
    delete ownedTokens[LEATHER];
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Material common_leather not owned' });
    expectNotClaimed();
  });

  it('400 when the owned quantity is below the recipe requirement (client quantity ignored)', async () => {
    ownedTokens[LEATHER].quantity = 1; // recipe needs 2; body claims 1000
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Insufficient common_leather: need 2, have 1' });
    expectNotClaimed();
  });

  it('404 when a transferred material output is not found (rejects before enqueue)', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0']); // only one output — common_leather at vout 1 is missing
    const res = await post(validBody);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Transfer output not found: BATCHTX.1' });
    expectNotClaimed();
  });

  it('400 when a transferred material is not locked to the server derived key (rejects before enqueue)', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'SOME_OTHER_LOCK_SCRIPT']);
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Material common_leather not locked to server derived key' });
    expectNotClaimed();
  });

  it('400 when the batch transfer does not spend the owned material token', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1'], [
      defaultBatchInputs[0],
      { sourceTXID: 'SOMEOTHERTX', sourceOutputIndex: 3 },
    ]);
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Material common_leather transfer does not spend owned token' });
    expectNotClaimed();
  });

  it.each([
    ['a foreign txid', 'OTHERTX.1'],
    ['a non-canonical vout', 'BATCHTX.01'],
  ])('400 when a transfer outpoint names %s', async (_label, tokenId) => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1']);
    const res = await post({
      ...validBody,
      transferredMaterials: [validBody.transferredMaterials[0], { ...validBody.transferredMaterials[1], tokenId }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: `Transfer outpoint not in batch transfer: ${tokenId}` });
    expectNotClaimed();
  });

  // The DB doc decides what the token is; the on-chain record must say the same.
  it.each([
    ['names another material', ['common_wood', 'rare_steel'], 'Material common_leather transfer is inscribed as rare_steel'],
    ['names no material', ['common_wood', undefined], 'Material common_leather transfer is inscribed as no lootTableId'],
  ])('400 when a transfer\'s metadata %s', async (_label, lootIds, error) => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1'], defaultBatchInputs, [7, 2], lootIds as string[]);
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
    expectNotClaimed();
  });

  it('400 when a transfer names another asset id than the owned token\'s mint', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1'], defaultBatchInputs, [7, 2], undefined, ['WOODMINT_0', 'LEATHERTX_0']);
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Material common_leather transfer names asset LEATHERTX_0, not its mint LEATHERMINT_0' });
    expectNotClaimed();
  });

  // Input i carries output i: the token at each named output must be the one its own input spends.
  it('400 when the owned tokens are spent, but not by the inputs paired with their outputs', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1'], [defaultBatchInputs[1], defaultBatchInputs[0]]);
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Material common_wood transfer does not spend owned token' });
    expectNotClaimed();
  });

  // No output beyond the named ones may carry a transferred token's asset (on-chain inflation).
  it('400 when another output also carries a transferred token\'s asset', async () => {
    seedPaymentAndBatchMocks(
      ['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1', 'USER_OWN_LOCK'],
      defaultBatchInputs,
      [7, 2, 7],
      ['common_wood', 'common_leather', 'common_wood'],
      ['WOODMINT_0', 'LEATHERMINT_0', 'WOODMINT_0'],
    );
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Output 2 also carries asset WOODMINT_0' });
    expectNotClaimed();
  });

  it('accepts unrelated extra outputs (wallet change) after the transferred ones', async () => {
    seedPaymentAndBatchMocks(
      ['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1', 'WALLET_CHANGE'],
      defaultBatchInputs,
      [7, 2, 1],
      ['common_wood', 'common_leather', undefined as unknown as string],
      ['WOODMINT_0', 'LEATHERMINT_0', undefined as unknown as string],
    );
    seedEnqueueMocks();
    const res = await post(validBody);
    expect(res.status).toBe(200);
  });

  // The spent output itself must be this token on chain, as the DB doc records it.
  it.each([
    ['another asset', { op: 'transfer' as const, amt: 2, id: 'OTHERMINT_0' }],
    ['another amount (DB drifted from chain)', { op: 'transfer' as const, amt: 9, id: 'LEATHERMINT_0' }],
    ['a deploy+mint away from the recorded mint outpoint', { op: 'deploy+mint' as const, amt: 2 }],
  ])('400 when the spent output is %s', async (_label, source) => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1'], [defaultBatchInputs[0], tokenInput('LEATHERTX', 0, source)]);
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Material common_leather spends an output that is not this token on chain' });
    expectNotClaimed();
  });

  it('accepts a token still at its mint outpoint (its source is the deploy+mint)', async () => {
    ownedTokens[LEATHER].tokenId = 'LEATHERMINT.0';
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1'], [
      defaultBatchInputs[0],
      tokenInput('LEATHERMINT', 0, { op: 'deploy+mint', amt: 2 }),
    ]);
    seedEnqueueMocks();
    const res = await post(validBody);
    expect(res.status).toBe(200);
  });

  it('400 when the BEEF does not carry the spent output\'s source tx', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1'], [defaultBatchInputs[0], { sourceTXID: 'LEATHERTX', sourceOutputIndex: 0 }]);
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Material common_leather spends an output that is not this token on chain' });
  });

  it('400 when the owned token has no recorded mint', async () => {
    delete ownedTokens[LEATHER].mintOutpoint;
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1']);
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Material common_leather has no recorded mint' });
    expectNotClaimed();
  });

  it('400 when a transfer output does not carry the whole owned token (on-chain split)', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1'], defaultBatchInputs, [7, 1]);
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Material common_leather transfer must carry the full token quantity (2)' });
    expectNotClaimed();
  });

  it('409 when a material token is listed on the marketplace', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1']);
    listingFindOne.mockResolvedValueOnce({ _id: 'LISTING', materialTokenId: LEATHER, status: 'pending' });

    const res = await post(validBody);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Material token is listed on the marketplace' });
    expect(listingFindOne).toHaveBeenCalledWith({
      materialTokenId: { $in: [WOOD, LEATHER] },
      status: { $in: ['active', 'pending'] },
    });
    expectNotClaimed();
  });

  it('claims nothing when the wallet queue cannot be obtained', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1']);
    getWalletQueue.mockRejectedValueOnce(new Error('queue down'));

    const res = await post(validBody);

    expect(res.status).toBe(500);
    expectNotClaimed();
  });

  it('still returns the BEEF when a DB write fails after the wallet succeeded, keeping the claim', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1']);
    seedEnqueueMocks();
    nftInsertOne.mockRejectedValueOnce(new Error('db down'));

    const res = await post(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      success: true,
      dbRecorded: false,
      tokenId: 'TRANSFERTX.0',
      transferBeef: 'BEEF_B64',
      received: [
        { outputIndex: 0, keyId: 'N_ITEM', counterparty: 'SERVER_ID', tags: ['type:item'] },
        { outputIndex: 1, keyId: 'N_CHANGE', counterparty: 'SERVER_ID', tags: ['type:material'] },
      ],
    }));
    // Claim held: the tokens are spent on chain, so they must not become usable again.
    expect(materialUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('409 and releases the claim when a material token is already in use by another request', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1']);
    materialUpdateMany.mockResolvedValueOnce({ modifiedCount: 1 }); // one of two tokens already claimed

    const res = await post(validBody);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Material tokens are already in use' });
    expect(materialUpdateMany).toHaveBeenCalledWith(
      {
        userId: 'u1',
        pendingClaim: { $exists: false },
        $or: [
          { _id: new ObjectId(WOOD), tokenId: 'WOODTX.0' },
          { _id: new ObjectId(LEATHER), tokenId: 'LEATHERTX.0' },
        ],
      },
      { $set: { pendingClaim: expect.any(String) } },
    );
    expect(materialUpdateMany).toHaveBeenLastCalledWith({ pendingClaim: tokenClaimId() }, { $unset: { pendingClaim: '' } });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('mints the recipe output (ignoring forged outputItem) via the wallet queue, writes DB after, returns the success shape', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1']);
    seedEnqueueMocks();
    jest.spyOn(Math, 'random').mockReturnValue(0.75); // statRoll = 0.8 + 0.75 * 0.4 = 1.1

    const res = await post(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      dbRecorded: true,
      nftId: 'NFT_OID',
      tokenId: 'TRANSFERTX.0',
      transferTransactionId: 'TRANSFERTX',
      materialChangeTokens: [{ lootTableId: 'common_wood', tokenId: 'TRANSFERTX.1', quantity: 2 }],
      statRoll: 1.1,
      rolledStats: { damageBonus: 1, autoClickRate: 0.55 },
      transferBeef: 'BEEF_B64',
      received: [
        { outputIndex: 0, keyId: 'N_ITEM', counterparty: 'SERVER_ID', tags: ['type:item'] },
        { outputIndex: 1, keyId: 'N_CHANGE', counterparty: 'SERVER_ID', tags: ['type:material'] },
      ],
    });

    // Both dependent wallet actions (mint crafted item, then transfer) ran as ONE unit
    // through the serialized queue, after the tokens were claimed.
    expect(enqueue).toHaveBeenCalledWith('craft', expect.any(Function));
    expect(materialUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(enqueue.mock.invocationCallOrder[0]);
    expect(stubWallet.createAction).toHaveBeenCalledTimes(2);
    expect(stubWallet.signAction).toHaveBeenCalledTimes(2);

    // Inscribed metadata comes from the recipe + loot table, not the request body.
    const craftedMetadata = expect.objectContaining({
      itemName: 'Rusty Dagger',
      rarity: 'common',
      itemType: 'weapon',
      tier: 1,
      stats: { damageBonus: 1, autoClickRate: 0.5 },
      crafted: { statRoll: 1.1, craftedBy: 'u1' },
      visual: { borderGradient: publicKeyToGradient('u1') },
    });
    expect(ordLock).toHaveBeenCalledWith('MINTKEY', '', craftedMetadata, 'deploy+mint', 1);
    expect(ordLock).toHaveBeenCalledWith('USERKEY', 'MINTTX_0', craftedMetadata, 'transfer', 1);
    // Material change: owned 7 - recipe 5 = 2, with loot-table metadata.
    // Change keeps the stack's BSV-21 id: its mint outpoint, not the batch outpoint it came through.
    expect(ordLock).toHaveBeenCalledWith(
      'USERKEY',
      'WOODMINT_0',
      { name: 'material_token', lootTableId: 'common_wood', itemName: 'Wooden Plank', description: 'Rough lumber for crafting', icon: '🪵', rarity: 'common', tier: 1 },
      'transfer',
      2,
    );

    // DB writes happened AFTER the enqueue resolved.
    expect(nftInsertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        lootTableId: 'common_dagger',
        name: 'Rusty Dagger',
        rarity: 'common',
        type: 'weapon',
        mintOutpoint: 'MINTTX.0',
        tokenId: 'TRANSFERTX.0',
        keyId: 'N_ITEM',
        counterparty: 'SERVER_ID',
      }),
    );
    expect(inventoryInsertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        lootTableId: 'common_dagger',
        itemType: 'weapon',
        tier: 1,
        crafted: true,
        statRoll: 1.1,
        rolledStats: { damageBonus: 1, autoClickRate: 0.55 },
        borderGradient: publicKeyToGradient('u1'),
        tokenId: 'TRANSFERTX.0',
      }),
    );
    // Token write-backs target the exact claimed doc.
    expect(materialDeleteOne).toHaveBeenCalledTimes(1);
    expect(materialDeleteOne).toHaveBeenCalledWith({ _id: new ObjectId(LEATHER), userId: 'u1', tokenId: 'LEATHERTX.0', pendingClaim: tokenClaimId() });
    expect(materialUpdateOne).toHaveBeenCalledTimes(1);
    expect(materialUpdateOne).toHaveBeenCalledWith(
      { _id: new ObjectId(WOOD), userId: 'u1', tokenId: 'WOODTX.0', pendingClaim: tokenClaimId() },
      expect.objectContaining({
        $set: expect.objectContaining({
          tokenId: 'TRANSFERTX.1',
          quantity: 2,
          keyId: 'N_CHANGE',
          counterparty: 'SERVER_ID',
          previousTokenId: 'WOODTX.0',
          lastTransactionId: 'TRANSFERTX',
        }),
        $unset: { pendingClaim: '' },
        $push: expect.objectContaining({
          updateHistory: expect.objectContaining({
            operation: 'subtract',
            previousQuantity: 7,
            newQuantity: 2,
            transactionId: 'TRANSFERTX',
            reason: 'Consumed in crafting recipe: craft_wooden_sword',
          }),
        }),
      }),
    );

    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(nftInsertOne.mock.invocationCallOrder[0]);
    expect(enqueue.mock.invocationCallOrder[0]).toBeLessThan(inventoryInsertOne.mock.invocationCallOrder[0]);

    // Overlay pushes for BOTH txs (intermediate mint + final transfer) are
    // fire-and-forget AFTER the response — flush pending microtasks so they've run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(broadcastTX).toHaveBeenCalledTimes(2);
  });

  it('combines several tokens of one material across tiers, consuming in order with per-token change', async () => {
    // Need 5 wood: T1 token holds 3 (fully consumed), T3 token holds 4 (2 used, 2 change).
    ownedTokens[WOOD].quantity = 3;
    const body = {
      ...validBody,
      transferredMaterials: [
        { lootTableId: 'common_wood', tokenId: 'BATCHTX.0', materialTokenId: WOOD },
        { lootTableId: 'common_wood', tokenId: 'BATCHTX.1', materialTokenId: WOOD_T3 },
        { lootTableId: 'common_leather', tokenId: 'BATCHTX.2', materialTokenId: LEATHER },
      ],
    };
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1', 'LOCK_PS_MARKER_2'], [
      tokenInput('WOODTX', 0, { op: 'transfer', amt: 3, id: 'WOODMINT_0' }),
      tokenInput('WOODT3TX', 0, { op: 'transfer', amt: 4, id: 'WOODT3MINT_0' }),
      defaultBatchInputs[1],
    ], [3, 4, 2], ['common_wood', 'common_wood', 'common_leather'], ['WOODMINT_0', 'WOODT3MINT_0', 'LEATHERMINT_0']);
    seedEnqueueMocks(3);

    const res = await post(body);

    expect(res.status).toBe(200);
    expect(res.body.materialChangeTokens).toEqual([{ lootTableId: 'common_wood', tokenId: 'TRANSFERTX.1', quantity: 2 }]);
    // Change keeps the T3 token's tier and asset lineage.
    expect(ordLock).toHaveBeenCalledWith(
      'USERKEY',
      'WOODT3MINT_0',
      expect.objectContaining({ lootTableId: 'common_wood', tier: 3 }),
      'transfer',
      2,
    );
    const claim = tokenClaimId();
    expect(materialDeleteOne).toHaveBeenCalledWith({ _id: new ObjectId(WOOD), userId: 'u1', tokenId: 'WOODTX.0', pendingClaim: claim });
    expect(materialDeleteOne).toHaveBeenCalledWith({ _id: new ObjectId(LEATHER), userId: 'u1', tokenId: 'LEATHERTX.0', pendingClaim: claim });
    expect(materialUpdateOne).toHaveBeenCalledTimes(1);
    expect(materialUpdateOne).toHaveBeenCalledWith(
      { _id: new ObjectId(WOOD_T3), userId: 'u1', tokenId: 'WOODT3TX.0', pendingClaim: claim },
      expect.objectContaining({ $set: expect.objectContaining({ tokenId: 'TRANSFERTX.1', quantity: 2 }) }),
    );
  });

  it('accepts its own material change as the owned token in the next craft', async () => {
    // Craft 1: 12 wood - 5 = 7 wood returned as change.
    ownedTokens[WOOD].quantity = 12;
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1'], [
      tokenInput('WOODTX', 0, { op: 'transfer', amt: 12, id: 'WOODMINT_0' }),
      defaultBatchInputs[1],
    ], [12, 2]);
    seedEnqueueMocks();
    expect((await post(validBody)).status).toBe(200);

    // The doc the route wrote back, and the craft tx as the route built it (outputs in order).
    const { $set } = materialUpdateOne.mock.calls[0][1];
    ownedTokens[WOOD] = { ...ownedTokens[WOOD], tokenId: $set.tokenId, quantity: $set.quantity };
    const craftTx = {
      outputs: stubWallet.createAction.mock.calls[1][0].outputs.map((o: { lockingScript: string }) => sourceOutput(JSON.parse(o.lockingScript))),
    };
    const [txid, vout] = $set.tokenId.split('.');

    // Craft 2 spends that change; the source-output check reads it from the craft tx.
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1'], [
      { sourceTXID: txid, sourceOutputIndex: Number(vout), sourceTransaction: craftTx },
      defaultBatchInputs[1],
    ], [7, 2]);
    seedEnqueueMocks();
    const res = await post(validBody);

    expect(res.status).toBe(200);
    expect(res.body.materialChangeTokens).toEqual([{ lootTableId: 'common_wood', tokenId: 'TRANSFERTX.1', quantity: 2 }]);
  });

  it('signs only its own inputs when the wallet adds funding inputs (every stack has change)', async () => {
    ownedTokens[LEATHER].quantity = 3; // 3 - 2 = 1 change; wood 7 - 5 = 2 change: no 1-sat input is freed for the fee
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1'], [
      defaultBatchInputs[0],
      tokenInput('LEATHERTX', 0, { op: 'transfer', amt: 3, id: 'LEATHERMINT_0' }),
    ], [7, 3]);
    seedEnqueueMocks(2, ['N_MINT', 'N_ITEM', 'N_CHANGE_1', 'N_CHANGE_2'], 1);

    const res = await post(validBody);

    expect(res.status).toBe(200);
    expect(stubWallet.signAction).toHaveBeenLastCalledWith({
      reference: 'REF2',
      spends: { 0: { unlockingScript: 'U0' }, 1: { unlockingScript: 'U1' }, 2: { unlockingScript: 'U2' } },
    });
  });

  it('500s and releases the token claim when the wallet queue throws', async () => {
    seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1']);
    enqueue.mockRejectedValueOnce(new Error('craft boom'));

    const res = await post(validBody);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(materialUpdateMany).toHaveBeenLastCalledWith({ pendingClaim: tokenClaimId() }, { $unset: { pendingClaim: '' } });
    expect(nftInsertOne).not.toHaveBeenCalled();
    expect(inventoryInsertOne).not.toHaveBeenCalled();
    expect(materialDeleteOne).not.toHaveBeenCalled();
  });

  // craft_mana_elixir (level 4): 3 ectoplasm + 1 spirit_crystal (artifact NFT) + 2 pixie_dust.
  describe('artifact inputs', () => {
    const ECTO = '64b000000000000000000011';
    const PIXIE = '64b000000000000000000012';
    const CRYSTAL = '64b000000000000000000013';
    const CRYSTAL_2 = '64b000000000000000000014';

    const elixirBody = {
      ...validBody,
      recipeId: 'craft_mana_elixir',
      transferredMaterials: [
        { lootTableId: 'ectoplasm', tokenId: 'BATCHTX.0', materialTokenId: ECTO },
        { lootTableId: 'pixie_dust', tokenId: 'BATCHTX.1', materialTokenId: PIXIE },
      ],
      transferredItems: [{ lootTableId: 'spirit_crystal', tokenId: 'BATCHTX.2', inventoryItemId: CRYSTAL }],
    };
    const elixirInputs = [
      tokenInput('ECTOTX', 0, { op: 'transfer', amt: 3, id: 'ECTOMINT_0' }),
      tokenInput('PIXIETX', 0, { op: 'transfer', amt: 2, id: 'PIXIEMINT_0' }),
      tokenInput('CRYSTALTX', 0, { op: 'transfer', amt: 1, id: 'CRYSTALMINT_0' }),
    ];
    const seedElixirBatch = (
      amts = [3, 2, 1],
      inputs: unknown[] = elixirInputs,
      lootIds = ['ectoplasm', 'pixie_dust', 'spirit_crystal'],
      assetIds = ['ECTOMINT_0', 'PIXIEMINT_0', 'CRYSTALMINT_0'],
    ) => seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1', 'LOCK_PS_MARKER_2'], inputs, amts, lootIds, assetIds);
    const itemClaimId = () => inventoryUpdateMany.mock.calls[0][1].$set.pendingClaim as string;

    beforeEach(() => {
      playerLevel = 4;
      ownedTokens[ECTO] = { lootTableId: 'ectoplasm', tokenId: 'ECTOTX.0', quantity: 3, tier: 1, mintOutpoint: 'ECTOMINT.0' };
      ownedTokens[PIXIE] = { lootTableId: 'pixie_dust', tokenId: 'PIXIETX.0', quantity: 2, tier: 1, mintOutpoint: 'PIXIEMINT.0' };
      ownedItems[CRYSTAL] = { lootTableId: 'spirit_crystal', tokenId: 'CRYSTALTX.0', mintOutpoint: 'CRYSTALMINT.0' };
      ownedItems[CRYSTAL_2] = { lootTableId: 'spirit_crystal', tokenId: 'CRYSTAL2TX.0', mintOutpoint: 'CRYSTAL2MINT.0' };
    });

    it('400 without the artifact the recipe requires', async () => {
      const res = await post({ ...elixirBody, transferredItems: [] });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Transferred materials do not match recipe craft_mana_elixir' });
      expectNotClaimed();
    });

    it('400 with more artifacts than the recipe consumes', async () => {
      const res = await post({
        ...elixirBody,
        transferredItems: [...elixirBody.transferredItems, { lootTableId: 'spirit_crystal', tokenId: 'BATCHTX.3', inventoryItemId: CRYSTAL_2 }],
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Transferred materials do not match recipe craft_mana_elixir' });
      expectNotClaimed();
    });

    it('400 when a material requirement is sent as an item', async () => {
      const res = await post({
        ...elixirBody,
        transferredMaterials: [elixirBody.transferredMaterials[0]],
        transferredItems: [...elixirBody.transferredItems, { lootTableId: 'pixie_dust', tokenId: 'BATCHTX.1', inventoryItemId: CRYSTAL_2 }],
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Transferred materials do not match recipe craft_mana_elixir' });
      expectNotClaimed();
    });

    it.each([
      ['a malformed inventoryItemId', [{ lootTableId: 'spirit_crystal', tokenId: 'BATCHTX.2', inventoryItemId: { $ne: null } }]],
      ['a batch outpoint already used by a material', [{ lootTableId: 'spirit_crystal', tokenId: 'BATCHTX.0', inventoryItemId: CRYSTAL }]],
    ])('400 when transferredItems has %s', async (_label, transferredItems) => {
      const res = await post({ ...elixirBody, transferredItems });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid transferredItems' });
      expectNotClaimed();
    });

    it('400 when the user does not own the minted artifact', async () => {
      delete ownedItems[CRYSTAL];
      const res = await post(elixirBody);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Item spirit_crystal not owned' });
      expect(inventoryFindOne).toHaveBeenCalledWith({
        _id: new ObjectId(CRYSTAL),
        userId: 'u1',
        lootTableId: 'spirit_crystal',
        nftLootId: { $type: 'objectId' },
        tokenId: { $type: 'string' },
      });
      expectNotClaimed();
    });

    it('409 when the artifact is equipped', async () => {
      equippedItems = { accessory1: new ObjectId(CRYSTAL) };
      const res = await post(elixirBody);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'Item spirit_crystal is equipped' });
      expectNotClaimed();
    });

    it('400 when the batch transfer does not spend the owned artifact', async () => {
      seedElixirBatch([3, 2, 1], [...elixirInputs.slice(0, 2), { sourceTXID: 'OTHERTX', sourceOutputIndex: 0 }]);
      const res = await post(elixirBody);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Item spirit_crystal transfer does not spend owned token' });
      expectNotClaimed();
    });

    it('400 when the artifact transfer does not carry amount 1', async () => {
      seedElixirBatch([3, 2, 2]);
      const res = await post(elixirBody);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Item spirit_crystal transfer must carry amount 1' });
      expectNotClaimed();
    });

    it('400 when the artifact transfer is inscribed as another item', async () => {
      seedElixirBatch(undefined, undefined, ['ectoplasm', 'pixie_dust', 'soul_stone']);
      const res = await post(elixirBody);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Item spirit_crystal transfer is inscribed as soul_stone' });
      expectNotClaimed();
    });

    it('400 when the artifact transfer names another asset id than its mint', async () => {
      seedElixirBatch(undefined, undefined, undefined, ['ECTOMINT_0', 'PIXIEMINT_0', 'CRYSTAL2MINT_0']);
      const res = await post(elixirBody);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Item spirit_crystal transfer names asset CRYSTAL2MINT_0, not its mint CRYSTALMINT_0' });
      expectNotClaimed();
    });

    it('409 when the artifact is listed on the marketplace', async () => {
      seedElixirBatch();
      listingFindOne
        .mockResolvedValueOnce(null) // materials
        .mockResolvedValueOnce({ _id: 'LISTING', inventoryItemId: CRYSTAL, status: 'active' });
      const res = await post(elixirBody);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'Item is listed on the marketplace' });
      expect(listingFindOne).toHaveBeenLastCalledWith({
        inventoryItemId: { $in: [CRYSTAL] },
        status: { $in: ['active', 'pending'] },
      });
      expectNotClaimed();
      expect(inventoryUpdateMany).not.toHaveBeenCalled();
    });

    it('409 and releases the material claim when the artifact is already claimed', async () => {
      seedElixirBatch();
      inventoryUpdateMany.mockResolvedValueOnce({ modifiedCount: 0 });
      const res = await post(elixirBody);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'Material tokens are already in use' });
      expect(inventoryUpdateMany).toHaveBeenCalledWith(
        { userId: 'u1', pendingClaim: { $exists: false }, $or: [{ _id: new ObjectId(CRYSTAL), tokenId: 'CRYSTALTX.0' }] },
        { $set: { pendingClaim: expect.any(String) } },
      );
      expect(materialUpdateMany).toHaveBeenLastCalledWith({ pendingClaim: tokenClaimId() }, { $unset: { pendingClaim: '' } });
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('releases both claims when the wallet queue throws', async () => {
      seedElixirBatch();
      enqueue.mockRejectedValueOnce(new Error('craft boom'));
      const res = await post(elixirBody);
      expect(res.status).toBe(500);
      expect(materialUpdateMany).toHaveBeenLastCalledWith({ pendingClaim: tokenClaimId() }, { $unset: { pendingClaim: '' } });
      expect(inventoryUpdateMany).toHaveBeenLastCalledWith({ pendingClaim: itemClaimId() }, { $unset: { pendingClaim: '' } });
      expect(inventoryDeleteOne).not.toHaveBeenCalled();
    });

    it('spends the artifact alongside the materials and deletes its inventory doc', async () => {
      seedElixirBatch();
      seedEnqueueMocks(3, ['N_MINT', 'N_ITEM']);

      const res = await post(elixirBody);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({ success: true, dbRecorded: true, materialChangeTokens: [] }));
      // The artifact is an input of the server's transfer, before the crafted item.
      const transferInputs = stubWallet.createAction.mock.calls[1][0].inputs.map((i: { outpoint: string }) => i.outpoint);
      expect(transferInputs).toEqual(['BATCHTX.0', 'BATCHTX.1', 'BATCHTX.2', 'MINTTX.0']);
      expect(ordLock).toHaveBeenCalledWith(
        'MINTKEY', '', expect.objectContaining({
          craftingProof: { recipeId: 'craft_mana_elixir', materialTokens: ['BATCHTX.0', 'BATCHTX.1'], itemTokens: ['BATCHTX.2'] },
        }), 'deploy+mint', 1,
      );
      expect(inventoryDeleteOne).toHaveBeenCalledWith({
        _id: new ObjectId(CRYSTAL), userId: 'u1', tokenId: 'CRYSTALTX.0', pendingClaim: itemClaimId(),
      });
      // An equip that raced the craft must not leave a slot pointing at the deleted doc.
      for (const slot of ['weapon', 'armor', 'accessory1', 'accessory2']) {
        expect(playerStatsUpdateOne).toHaveBeenCalledWith(
          { userId: 'u1', [`equippedItems.${slot}`]: { $in: [new ObjectId(CRYSTAL)] } },
          { $unset: { [`equippedItems.${slot}`]: '' } },
        );
      }
    });

    it('touches no equipped slot when the recipe consumes no items', async () => {
      seedPaymentAndBatchMocks(['LOCK_PS_MARKER_0', 'LOCK_PS_MARKER_1']);
      seedEnqueueMocks();
      const res = await post(validBody);
      expect(res.status).toBe(200);
      expect(playerStatsUpdateOne).not.toHaveBeenCalled();
    });
  });
});
